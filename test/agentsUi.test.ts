import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Agent } from "../src/agent.js";
import { agentModel, formatAgent, loadAgents, parseAgent, updateAgentFile } from "../src/agents.js";
import { parseGenerated } from "../src/agentWizard.js";
import { LLM } from "../src/llm.js";
import { Permissions } from "../src/permissions.js";
import type { Session } from "../src/session.js";
import { runSlash } from "../src/slash.js";
import { taskTool } from "../src/tools/task.js";
import type { Tool } from "../src/types.js";
import type { SelectAnswer, SelectRequest } from "../src/ui.js";
import { fakeModel, recordingUi, testConfig, tmpDir, type FakeTurn } from "./helpers.js";

let stops: (() => void)[] = [];
const XDG = process.env.XDG_CONFIG_HOME;
afterEach(() => {
  for (const s of stops) s();
  stops = [];
  if (XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = XDG;
});

const tool = (name: string, risk: Tool["risk"]): Tool => ({ name, description: `${name}. More.`, parameters: { type: "object", properties: {} }, risk, run: async () => `${name} ok` });

/** A chat session whose menus and questions are answered from a script; the user's config dir is a temp folder. */
function session(answers: (string | SelectAnswer | null)[], turns: FakeTurn[] = []) {
  const model = fakeModel(turns);
  stops.push(model.stop);
  const dir = tmpDir();
  const xdg = tmpDir();
  process.env.XDG_CONFIG_HOME = xdg;
  const config = testConfig({ baseURL: model.baseURL, model: "fake-model", maxRetries: 0, cwd: dir, mode: "auto" });
  const { ui, log } = recordingUi("y");
  const asked: SelectRequest[] = [];
  const script = [...answers];
  ui.select = async (req) => {
    asked.push(req);
    const a = script.shift();
    return a === undefined || a === null ? null : typeof a === "string" ? { values: [a], alt: false } : a;
  };
  ui.input = async (req) => {
    asked.push({ title: req.title, options: [] });
    const a = script.shift();
    return typeof a === "string" ? a : null;
  };
  const tools = [tool("read_file", "safe"), tool("edit_file", "write"), tool("bash", "exec"), tool("mcp__pw__browser_click", "write")];
  const llm = new LLM(config);
  const agent = new Agent({ config, llm, tools, ui, perms: new Permissions(ui, config.mode), systemPrompt: "test", memory: null });
  const s = { agent, llm, memory: null, tools, agents: loadAgents(dir, path.join(xdg, "ngobe")) } as unknown as Session;
  const env = { config, session: s, ui, abortable: <T>(fn: (signal: AbortSignal) => Promise<T>) => fn(new AbortController().signal) };
  return { env, s, log, asked, dir, xdg, model, config };
}

describe("agent files (Claude Code's format)", () => {
  test("model and color are read; Claude Code's YAML lists, quotes and model aliases work", () => {
    const def = parseAgent(
      '---\nname: reviewer\ndescription: "Reviews code: bugs first"\ntools:\n  - Read\n  - Grep\nmodel: sonnet\ncolor: purple\npermissionMode: plan\n---\nYou review code.',
      "project",
    )!;
    expect(def).toMatchObject({ name: "reviewer", description: "Reviews code: bugs first", tools: ["read_file", "grep"], model: "sonnet", color: "purple", prompt: "You review code." });
    // This endpoint doesn't serve Claude's models: they mean the main conversation's.
    expect(agentModel(def, "qwen-7b")).toBe("qwen-7b");
    expect(agentModel({ model: "inherit" }, "qwen-7b")).toBe("qwen-7b");
    expect(agentModel({}, "qwen-7b")).toBe("qwen-7b");
    expect(agentModel({ model: "qwen-1.5b" }, "qwen-7b")).toBe("qwen-1.5b");
  });

  test("a new agent is written with only the fields set, and reads back the same", () => {
    const text = formatAgent({ name: "test-runner", description: "Runs tests: explains failures", tools: ["bash", "read_file"], model: "inherit", color: "green", prompt: "You run the tests." });
    expect(text).toBe('---\nname: test-runner\ndescription: "Runs tests: explains failures"\ntools: bash, read_file\nmodel: inherit\ncolor: green\n---\n\nYou run the tests.\n');
    expect(parseAgent(text, "user")).toMatchObject({ name: "test-runner", description: "Runs tests: explains failures", tools: ["bash", "read_file"], model: "inherit", color: "green", prompt: "You run the tests." });
    expect(formatAgent({ name: "x", description: "Does x", prompt: "p" })).toBe("---\nname: x\ndescription: Does x\n---\n\np\n");
  });

  test("editing changes only the field asked for; Claude Code's own fields and the prompt stay", () => {
    const dir = path.join(tmpDir(), ".claude", "agents");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "reviewer.md");
    fs.writeFileSync(file, "---\nname: reviewer\ndescription: Reviews\ntools:\n  - Read\n  - Grep\nhooks: x\n---\n\nYou review.\n");
    updateAgentFile(file, { tools: ["read_file", "bash"], model: "qwen-1.5b" });
    // In .claude/agents, tool names stay Claude Code's.
    expect(fs.readFileSync(file, "utf8")).toBe("---\nname: reviewer\ndescription: Reviews\ntools: Read, Bash\nhooks: x\nmodel: qwen-1.5b\n---\n\nYou review.\n");
    updateAgentFile(file, { tools: undefined, color: "red" });
    expect(fs.readFileSync(file, "utf8")).toBe("---\nname: reviewer\ndescription: Reviews\nhooks: x\nmodel: qwen-1.5b\ncolor: red\n---\n\nYou review.\n");
  });

  test("a generated agent is read from the model's reply: fenced, Claude Code's keys, or unusable", () => {
    expect(parseGenerated('Here it is:\n```json\n{"name": "Bug Hunter", "description": "Finds bugs", "prompt": "You hunt bugs."}\n```', ["bug-hunter"])).toEqual({
      name: "bug-hunter-2",
      description: "Finds bugs",
      prompt: "You hunt bugs.",
    });
    expect(parseGenerated('{"identifier": "doc-writer", "whenToUse": "Writes docs", "systemPrompt": "You write docs."}', [])).toEqual({ name: "doc-writer", description: "Writes docs", prompt: "You write docs." });
    expect(parseGenerated('{"description": "Writes the release notes", "prompt": "p"}', [])?.name).toBe("writes-the-release");
    expect(parseGenerated('{"name": "x", "description": "d"}', [])).toBeNull(); // no prompt
    expect(parseGenerated("I can't do that.", [])).toBeNull();
  });
});

describe("/agents", () => {
  test("create with the model: location, description, tools, model, color, save; the task tool knows it at once", async () => {
    const reply = '```json\n{"name": "test-runner", "description": "Runs the tests after changes and explains failures", "prompt": "You run the project\'s tests and report failures with file:line."}\n```';
    const { env, s, asked, dir, log, model } = session(
      [
        "+", // Create new agent
        "project",
        "generate",
        "runs my tests after every change and explains what failed",
        { values: ["group:read", "bash"], alt: false },
        "fake-model",
        "green",
        "save",
        null, // back at the list: esc
      ],
      [{ content: reply }],
    );
    expect(s.tools.map((t) => t.name)).not.toContain("task"); // only built-in agents so far
    await runSlash("/agents", env);
    expect(asked.map((a) => a.title)).toEqual([
      "Agents",
      "Choose location",
      "Creation method",
      "Describe what this agent should do and when it should be used",
      "Select tools (space checks, enter when done)",
      "Select model",
      "Choose background color",
      "Save test-runner?",
      "Agents",
    ]);
    expect(asked[2].options[0].label).toBe("Generate with fake-model (recommended)");
    // Groups, then each tool; MCP tools are a group of their own.
    expect(asked[4].options.map((o) => o.value)).toEqual(["*", "group:read", "group:edit", "group:exec", "group:mcp", "read_file", "edit_file", "bash", "mcp__pw__browser_click"]);
    expect(asked[5].options.map((o) => o.value)).toEqual(["inherit", "fake-model"]);
    expect(fs.readFileSync(path.join(dir, ".ngobe", "agents", "test-runner.md"), "utf8")).toBe(
      "---\nname: test-runner\ndescription: Runs the tests after changes and explains failures\ntools: read_file, bash\nmodel: fake-model\ncolor: green\n---\n\nYou run the project's tests and report failures with file:line.\n",
    );
    // One short request to the model, with the user's description.
    expect(model.requests).toHaveLength(1);
    expect(JSON.stringify(model.requests[0].messages)).toContain("runs my tests after every change");
    expect(s.agents.map((a) => a.name)).toContain("test-runner");
    expect(s.tools.map((t) => t.name)).toContain("task");
    expect(log.notes.join("\n")).toContain('subagent_type "test-runner"');
    // The new list shows it first, as a project agent.
    expect(asked[8].options[1]).toMatchObject({ value: "test-runner", description: "Project · Runs the tests after changes and explains failures" });
  });

  test("manual configuration, for every project: all tools, inherited model, automatic color", async () => {
    const { env, xdg } = session(["+", "user", "manual", "Doc Writer", "Writes and updates docs", "You write docs.", { values: ["*"], alt: false }, "inherit", "auto", "save", null]);
    await runSlash("/agents", env);
    expect(fs.readFileSync(path.join(xdg, "ngobe", "agents", "doc-writer.md"), "utf8")).toBe("---\nname: doc-writer\ndescription: Writes and updates docs\nmodel: inherit\n---\n\nYou write docs.\n");
  });

  test("nothing checked asks again; esc anywhere saves nothing", async () => {
    const { env, dir, log, asked } = session(["+", "project", "manual", "a", "b", "c", { values: [], alt: false }, null, null]);
    await runSlash("/agents", env);
    expect(log.notes).toContain("Check at least one tool, or All tools.");
    expect(asked.filter((a) => a.title.startsWith("Select tools"))).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, ".ngobe"))).toBe(false);
  });

  test("an agent's tools, model and color can be changed, and it can be deleted; built-ins only shown", async () => {
    const { env, dir, s, log } = session(["reviewer", "model", "fake-model", "reviewer", "color", "cyan", "reviewer", "delete", "yes", "explore", null]);
    const file = path.join(dir, ".ngobe", "agents", "reviewer.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, formatAgent({ name: "reviewer", description: "Reviews", prompt: "You review." }));
    s.agents.splice(0, s.agents.length, ...loadAgents(dir, path.join(process.env.XDG_CONFIG_HOME!, "ngobe")));
    // The file as it is each time the list opens again.
    const seen: string[] = [];
    const select = env.ui.select!;
    env.ui.select = (req) => {
      if (req.title === "Agents" && fs.existsSync(file)) seen.push(fs.readFileSync(file, "utf8"));
      return select(req);
    };
    await runSlash("/agents", env);
    expect(log.notes).toContain("Updated reviewer.");
    expect(log.notes).toContain("Deleted reviewer.");
    expect(seen.some((t) => t.includes("model: fake-model\ncolor: cyan"))).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(s.agents.map((a) => a.name)).not.toContain("reviewer");
    expect(log.notes.at(-1)).toContain("Built-in agents can't be changed.");
  });

  test("without menus (one-shot, tests) /agents still lists, and /agents new still scaffolds", async () => {
    const { env } = session([]);
    delete env.ui.select;
    delete env.ui.input;
    await runSlash("/agents", env);
    await runSlash("/agents new checker", env);
    expect(env.session.agents.map((a) => a.name)).toContain("checker"); // usable without a restart
  });
});

describe("sub-agents and /model", () => {
  test("a sub-agent runs on its own model; the main conversation keeps its own", async () => {
    const model = fakeModel([
      { toolCalls: [{ name: "task", arguments: JSON.stringify({ description: "check", prompt: "Check it", subagent_type: "small" }) }] },
      { content: "All good." }, // the sub-agent
      { content: "Checked." },
    ]);
    stops.push(model.stop);
    const config = testConfig({ baseURL: model.baseURL, model: "big-model", maxRetries: 0, cwd: tmpDir(), mode: "auto" });
    const { ui } = recordingUi("y");
    const small ={ name: "small", description: "checks", prompt: "You check.", source: "project" as const, model: "small-model", color: "pink" };
    const read = tool("read_file", "safe");
    const agent = new Agent({ config, llm: new LLM(config), tools: [read, taskTool([small])], ui, perms: new Permissions(ui, config.mode), systemPrompt: "test", memory: null });
    expect((await agent.run("check it", new AbortController().signal)).text).toBe("Checked.");
    expect(model.requests.map((r) => r.model)).toEqual(["big-model", "small-model", "big-model"]);
  });

  test("/model opens a picker: enter switches and saves the default, s switches for this session only", async () => {
    const saved = () => {
      const file = path.join(process.env.XDG_CONFIG_HOME!, "ngobe", "config.json");
      return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { model?: string }).model : undefined;
    };
    const { env, config, asked, log } = session([{ values: ["fake-model"], alt: true }, { values: ["fake-model"], alt: false }]);
    config.model = "other";
    await runSlash("/model", env);
    expect(asked[0]).toMatchObject({ title: "Select model", alt: { key: "s", label: "this session only" } });
    expect(asked[0].options[0]).toMatchObject({ value: "fake-model", description: "8.0B params · 4.5 GB" });
    expect(config.model).toBe("fake-model");
    expect(saved()).toBeUndefined();
    expect(log.notes.at(-1)).toBe("Model: fake-model (this session only).");
    await runSlash("/model", env);
    expect(saved()).toBe("fake-model");
  });
});
