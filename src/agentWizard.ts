import fs from "node:fs";
import path from "node:path";
import { AGENT_COLORS, agentModel, agentName, agentsDir, loadAgents, saveAgent, updateAgentFile, type AgentDef } from "./agents.js";
import { configFilePath } from "./config.js";
import { describeModel, type LLM } from "./llm.js";
import type { SlashEnv } from "./slash.js";
import { taskToolFor } from "./tools/index.js";
import type { Tool } from "./types.js";
import type { SelectOption, SelectRequest, Ui } from "./ui.js";

/**
 * /agents in the chat, like Claude Code's: the agents by scope, a guided "Create new agent"
 * (where, generated from a description or written by hand, tools, model, color), and editing or
 * deleting one. Files are Claude Code's format (agents.ts); the task tool is rebuilt after every
 * change, so new agents work without a restart.
 */

export type Menus = Required<Pick<Ui, "select" | "input">> & Ui;

const SCOPE_LABEL: Record<AgentDef["source"], string> = { project: "Project", user: "Personal", "built-in": "Built-in" };

export async function agentsMenu(env: SlashEnv & { ui: Menus }): Promise<void> {
  const { session, ui } = env;
  for (;;) {
    const order = { project: 0, user: 1, "built-in": 2 };
    const agents = [...session.agents].sort((a, b) => order[a.source] - order[b.source] || a.name.localeCompare(b.name));
    const choice = await pick(ui, {
      title: "Agents",
      options: [
        { value: "+", label: "Create new agent" },
        ...agents.map((a) => ({ value: a.name, label: a.name, description: `${SCOPE_LABEL[a.source]} · ${a.description}` })),
      ],
    });
    if (choice === null) return;
    if (choice === "+") await createAgent(env);
    else await agentActions(env, agents.find((a) => a.name === choice)!);
  }
}

async function createAgent(env: SlashEnv & { ui: Menus }): Promise<void> {
  const { session, config, ui } = env;
  const configDir = path.dirname(configFilePath());
  const scope = await pick(ui, {
    title: "Choose location",
    options: [
      { value: "project", label: "Project (.ngobe/agents/)", description: "this project only; commit it to share it" },
      { value: "user", label: "Personal (~/.config/ngobe/agents/)", description: "every project on this machine" },
    ],
  });
  if (scope !== "project" && scope !== "user") return;
  const method = await pick(ui, {
    title: "Creation method",
    options: [
      { value: "generate", label: `Generate with ${config.model} (recommended)`, description: "describe it; the model writes the name, description and instructions" },
      { value: "manual", label: "Manual configuration", description: "write them yourself" },
    ],
  });
  if (!method) return;
  const taken = session.agents.map((a) => a.name);
  const draft = method === "generate" ? await generated(env, taken) : await written(ui, taken);
  if (!draft) return;
  const tools = await chooseTools(ui, session.tools, undefined);
  if (tools === null) return;
  const model = await chooseModel(env, undefined);
  if (model === null) return;
  const color = await chooseColor(ui, undefined);
  if (color === null) return;
  const def = { ...draft, tools, model, color };
  const dir = agentsDir(scope, config.cwd, configDir);
  ui.info(
    [
      `${def.name} → ${path.join(dir, `${def.name}.md`)}`,
      `description: ${def.description}`,
      `tools: ${def.tools?.join(", ") ?? "all"} · model: ${def.model} · color: ${def.color ?? "automatic"}`,
      "",
      ...def.prompt.split("\n").slice(0, 8),
    ].join("\n"),
  );
  if ((await pick(ui, { title: `Save ${def.name}?`, options: [{ value: "save", label: "Save" }, { value: "cancel", label: "Cancel" }] })) !== "save") return;
  try {
    const file = saveAgent(dir, def);
    reloadAgents(env);
    ui.info(`Created ${file}. The main agent can hand it work now (task tool, subagent_type "${def.name}").`);
  } catch (err) {
    ui.warn(err instanceof Error ? err.message : String(err));
  }
}

async function agentActions(env: SlashEnv & { ui: Menus }, def: AgentDef): Promise<void> {
  const { ui, config } = env;
  const details = [
    `${def.name} (${SCOPE_LABEL[def.source]}${def.path ? `, ${def.path}` : ""})`,
    `description: ${def.description}`,
    `tools: ${def.tools?.join(", ") ?? "all"} · model: ${def.model ?? "inherit"} (runs on ${agentModel(def, config.model)}) · color: ${def.color ?? "automatic"}`,
    "",
    def.prompt,
  ].join("\n");
  if (def.source === "built-in" || !def.path) {
    ui.info(`${details}\n\nBuilt-in agents can't be changed.`);
    return;
  }
  const action = await pick(ui, {
    title: def.name,
    options: [
      { value: "view", label: "View agent" },
      { value: "tools", label: "Edit tools", description: def.tools?.join(", ") ?? "all tools" },
      { value: "model", label: "Edit model", description: def.model ?? "inherit" },
      { value: "color", label: "Edit color", description: def.color ?? "automatic" },
      { value: "delete", label: "Delete agent" },
    ],
  });
  try {
    if (action === "view") ui.info(details);
    else if (action === "tools") {
      const tools = await chooseTools(ui, env.session.tools, def.tools);
      if (tools === null) return;
      updateAgentFile(def.path, { tools });
    } else if (action === "model") {
      const model = await chooseModel(env, def.model);
      if (model === null) return;
      updateAgentFile(def.path, { model });
    } else if (action === "color") {
      const color = await chooseColor(ui, def.color);
      if (color === null) return;
      updateAgentFile(def.path, { color });
    } else if (action === "delete") {
      const sure = await pick(ui, { title: `Delete ${def.path}?`, options: [{ value: "no", label: "No, keep it" }, { value: "yes", label: "Yes, delete it" }] });
      if (sure !== "yes") return;
      fs.unlinkSync(def.path);
    } else return;
    if (action !== "view") {
      reloadAgents(env);
      ui.info(action === "delete" ? `Deleted ${def.name}.` : `Updated ${def.name}.`);
    }
  } catch (err) {
    ui.warn(err instanceof Error ? err.message : String(err));
  }
}

/** The single value chosen, or null. */
async function pick(ui: Menus, req: SelectRequest): Promise<string | null> {
  return (await ui.select(req))?.values[0] ?? null;
}

type Draft = Pick<AgentDef, "name" | "description" | "prompt">;

async function written(ui: Menus, taken: string[]): Promise<Draft | null> {
  const raw = await ui.input({ title: "Agent name", placeholder: "lowercase letters, digits and dashes, e.g. test-runner" });
  if (!raw) return null;
  const name = agentName(raw, taken);
  if (name !== raw) ui.info(`Name: ${name}`);
  const description = await ui.input({ title: "Description: when should the main agent use it?", placeholder: "e.g. Runs the tests after code changes and explains failures" });
  if (!description) return null;
  const prompt = await ui.input({ title: "System prompt: its job, how to do it well, what its report must contain", placeholder: "You are …" });
  if (!prompt) return null;
  return { name, description, prompt };
}

const GENERATE_PROMPT = `You write sub-agent definitions for a coding agent. The user describes the agent they want. Reply with only a JSON object, no other text:
{"name": "short-lowercase-id-with-dashes", "description": "one sentence: when the main agent should hand work to it", "prompt": "its system prompt: 3 to 6 sentences in the second person (its job, how to do it well, what its final report must contain)"}`;

async function generated(env: SlashEnv & { ui: Menus }, taken: string[]): Promise<Draft | null> {
  const { ui, session } = env;
  const what = await ui.input({ title: "Describe what this agent should do and when it should be used", placeholder: "e.g. reviews my changes for bugs and security issues before I commit" });
  if (!what) return null;
  const since = Date.now();
  let chars = 0;
  ui.activity({ label: "Generating the agent", since, tokens: 0 });
  try {
    const text = await env.abortable((signal) => generateAgent(session.llm, what, signal, (n) => ui.activity({ label: "Generating the agent", since, tokens: Math.ceil((chars += n) / 4) })));
    if (text === undefined) return null; // interrupted
    const draft = parseGenerated(text, taken);
    if (!draft) ui.warn("The model's answer wasn't a usable agent definition. Try again, or choose Manual configuration.");
    return draft;
  } finally {
    ui.activity(null);
  }
}

/** One short request: the model writes the agent as JSON (a small model on a CPU writes ~4 tokens/s). */
export async function generateAgent(llm: LLM, description: string, signal: AbortSignal, progress: (chars: number) => void = () => {}): Promise<string> {
  const turn = await llm.chat(
    [
      { role: "system", content: GENERATE_PROMPT },
      { role: "user", content: description },
    ],
    [],
    (chunk) => progress(chunk.length),
    signal,
  );
  return turn.content;
}

/**
 * The agent in the model's reply: a JSON object, fenced or not, with name, description and prompt
 * (Claude Code's own names identifier, whenToUse and systemPrompt also count). Null when unusable.
 */
export function parseGenerated(text: string, taken: string[]): Draft | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (...keys: string[]) => keys.map((k) => v[k]).find((x): x is string => typeof x === "string" && x.trim() !== "")?.trim();
  const description = str("description", "whenToUse", "when_to_use");
  const prompt = str("prompt", "systemPrompt", "system_prompt", "instructions");
  if (!description || !prompt) return null;
  return { name: agentName(str("name", "identifier") ?? description.split(/\s+/).slice(0, 3).join("-"), taken), description, prompt };
}

// Tool groups, as Claude Code's tool picker shows them.
const GROUPS: [string, string, (t: Tool) => boolean][] = [
  ["read", "Read-only tools", (t) => !t.name.startsWith("mcp__") && (t.risk === "safe" || t.risk === "network")],
  ["edit", "Edit tools", (t) => !t.name.startsWith("mcp__") && t.risk === "write"],
  ["exec", "Execution tools", (t) => !t.name.startsWith("mcp__") && t.risk === "exec"],
  ["mcp", "MCP tools", (t) => t.name.startsWith("mcp__")],
];

/** undefined = all tools (inherited), a list = only those, null = cancelled. */
async function chooseTools(ui: Menus, available: Tool[], current: string[] | undefined): Promise<string[] | undefined | null> {
  const tools = available.filter((t) => t.name !== "task");
  const groups = GROUPS.map(([key, label, has]) => ({ key, label, members: tools.filter(has).map((t) => t.name) })).filter((g) => g.members.length);
  const options: SelectOption[] = [
    { value: "*", label: "All tools", description: "everything the main agent has", checked: current === undefined },
    ...groups.map((g) => ({ value: `group:${g.key}`, label: g.label, description: g.members.join(", ") })),
    ...tools.map((t) => ({ value: t.name, label: t.name, description: t.description.split(/(?<=\.)\s/)[0].slice(0, 70), checked: current?.includes(t.name) })),
  ];
  for (;;) {
    const answer = await ui.select({ title: "Select tools (space checks, enter when done)", options, multi: true });
    if (!answer) return null;
    if (answer.values.includes("*")) return undefined;
    const chosen = new Set(answer.values.flatMap((v) => (v.startsWith("group:") ? (groups.find((g) => `group:${g.key}` === v)?.members ?? []) : [v])));
    if (chosen.size) return tools.map((t) => t.name).filter((n) => chosen.has(n));
    ui.warn("Check at least one tool, or All tools.");
  }
}

/** "inherit" or a model id on the endpoint; null = cancelled. */
async function chooseModel(env: SlashEnv & { ui: Menus }, current: string | undefined): Promise<string | null> {
  const { ui, session, config } = env;
  let models: SelectOption[] = [];
  try {
    models = (await session.llm.models()).map((m) => ({ value: m.id, label: m.id, description: describeModel(m) }));
  } catch (err) {
    ui.warn(`Could not list the server's models (${err instanceof Error ? err.message : String(err)}); inherit is still available.`);
  }
  const options = [{ value: "inherit", label: "Inherit from the main conversation", description: config.model }, ...models];
  return pick(ui, { title: "Select model", options, initial: Math.max(0, options.findIndex((o) => o.value === current)) });
}

/** A color, undefined for automatic, null = cancelled. */
async function chooseColor(ui: Menus, current: string | undefined): Promise<string | undefined | null> {
  const options = [{ value: "auto", label: "Automatic color" }, ...Object.keys(AGENT_COLORS).map((c) => ({ value: c, label: c }))];
  const color = await pick(ui, { title: "Choose background color", options, initial: Math.max(0, options.findIndex((o) => o.value === current)) });
  return color === null ? null : color === "auto" ? undefined : color;
}

/** Read the agent files again and rebuild the task tool from them: changes work without a restart. */
export function reloadAgents(env: Pick<SlashEnv, "session" | "config">): void {
  const { session, config } = env;
  session.agents.splice(0, session.agents.length, ...loadAgents(config.cwd, path.dirname(configFilePath())));
  const task = taskToolFor(config, session.agents)?.[0];
  const at = session.tools.findIndex((t) => t.name === "task");
  if (at >= 0 && task) session.tools[at] = task;
  else if (at >= 0) session.tools.splice(at, 1);
  else if (task) session.tools.push(task);
}
