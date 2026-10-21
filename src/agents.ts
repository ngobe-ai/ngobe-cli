import fs from "node:fs";
import path from "node:path";

/**
 * Sub-agent definitions. A sub-agent gets one task and a fresh context, works with its own
 * (often smaller) tool set, and returns a single report: the main conversation only pays for
 * the report, not for every file the sub-agent read.
 *
 * Custom agents are markdown files with frontmatter, the same format Claude Code uses:
 *
 *   ---
 *   name: test-runner
 *   description: Runs the tests and explains failures
 *   tools: bash, read_file, grep
 *   model: inherit
 *   color: green
 *   ---
 *   You run the project's tests…
 *
 * Read from .ngobe/agents/ (project), ~/.config/ngobe/agents/ (user) and .claude/agents/
 * (project, for compatibility; Claude Code tool names are mapped to ngobe's). Fields ngobe
 * doesn't use (permissionMode, skills, hooks…) are left as they are when a file is edited.
 */

export interface AgentDef {
  name: string;
  description: string;
  /** Tool names it may use; undefined = every tool the main agent has (except task). */
  tools?: string[];
  prompt: string;
  source: "built-in" | "project" | "user";
  path?: string;
  /** "inherit" (the main conversation's), or a model id on the endpoint; see agentModel. */
  model?: string;
  /** Its color in the transcript. */
  color?: string;
}

/** The colors an agent can have, as in Claude Code, and how they are drawn. */
export const AGENT_COLORS: Record<string, string> = {
  red: "#e5484d",
  blue: "#3e8ef7",
  green: "#30a46c",
  yellow: "#f5d90a",
  purple: "#8e4ec6",
  orange: "#f76b15",
  pink: "#d6409f",
  cyan: "#05a2c2",
};

// Claude Code's model aliases: this endpoint doesn't serve them, so they mean the main model.
const CLAUDE_MODELS = new Set(["sonnet", "opus", "haiku", "fable", "opusplan"]);

/** The model an agent runs on: its own, or the main conversation's for inherit and Claude's models. */
export function agentModel(def: Pick<AgentDef, "model">, main: string): string {
  const m = def.model?.trim() ?? "";
  return !m || m === "inherit" || CLAUDE_MODELS.has(m.toLowerCase()) || /^claude-/i.test(m) ? main : m;
}

export const BUILTIN_AGENTS: AgentDef[] = [
  {
    name: "general-purpose",
    description: "multi-step research or changes that need many steps",
    prompt: "Complete the task fully, then report what you did and found.",
    source: "built-in",
  },
  {
    name: "explore",
    description: "read-only: find code, trace how something works, answer questions about the codebase",
    tools: ["read_file", "glob", "grep", "git_status", "git_diff", "git_log"],
    prompt: "Search the codebase to answer the question. Do not change anything. Report the answer with file:line references.",
    source: "built-in",
  },
];

/** Claude Code tool names → ngobe's, so .claude/agents definitions work as they are. */
const CLAUDE_TOOLS: Record<string, string> = {
  Read: "read_file",
  Edit: "edit_file",
  MultiEdit: "multi_edit",
  Write: "write_file",
  Glob: "glob",
  Grep: "grep",
  Bash: "bash",
  BashOutput: "bash_output",
  KillShell: "kill_shell",
  WebFetch: "fetch_url",
  WebSearch: "web_search",
  TodoWrite: "todo_write",
};

const NGOBE_TOOLS: Record<string, string> = Object.fromEntries(Object.entries(CLAUDE_TOOLS).map(([claude, ngobe]) => [ngobe, claude]));

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** A YAML scalar as written ("a: b" in quotes), back to its text. */
function scalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      // not JSON-style: strip the quotes below
    }
  }
  return v.replace(/^["']|["']$/g, "");
}

/** A value safe as a YAML scalar: plain when it can be, else double-quoted. */
function yamlValue(v: string): string {
  return /^\w[\w .,()/@+-]*$/.test(v) ? v : JSON.stringify(v);
}

export function parseAgent(text: string, source: AgentDef["source"], file?: string): AgentDef | null {
  const m = FRONTMATTER.exec(text);
  if (!m) return null;
  const meta: Record<string, string> = {};
  let list: string | null = null; // "tools:" followed by "  - Read" lines (a YAML list)
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s*(.+)$/.exec(line);
    if (item && list) {
      meta[list] = [meta[list], scalar(item[1])].filter(Boolean).join(", ");
      continue;
    }
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    meta[kv[1]] = scalar(kv[2]);
    list = kv[2].trim() ? null : kv[1];
  }
  const name = meta.name?.toLowerCase();
  if (!name || !NAME.test(name) || !meta.description) return null;
  const tools = meta.tools
    ? meta.tools
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map(scalar)
        .filter(Boolean)
        .map((t) => CLAUDE_TOOLS[t] ?? t)
    : undefined;
  return { name, description: meta.description, tools, prompt: m[2].trim(), source, path: file, model: meta.model || undefined, color: meta.color || undefined };
}

/** A new agent's file: Claude Code's format, with only the fields that are set. */
export function formatAgent(def: Pick<AgentDef, "name" | "description" | "tools" | "model" | "color" | "prompt">): string {
  const lines = [`name: ${def.name}`, `description: ${yamlValue(def.description.replace(/\s+/g, " ").trim())}`];
  if (def.tools) lines.push(`tools: ${def.tools.join(", ")}`);
  if (def.model) lines.push(`model: ${yamlValue(def.model)}`);
  if (def.color) lines.push(`color: ${def.color}`);
  return `---\n${lines.join("\n")}\n---\n\n${def.prompt.trim()}\n`;
}

/** Where agents of a scope live: the project's .ngobe/agents, or ~/.config/ngobe/agents for every project. */
export function agentsDir(scope: "project" | "user", cwd: string, configDir: string): string {
  return scope === "project" ? path.join(cwd, ".ngobe", "agents") : path.join(configDir, "agents");
}

/** Write a new agent's file; an existing file of that name is refused. */
export function saveAgent(dir: string, def: Parameters<typeof formatAgent>[0]): string {
  if (!NAME.test(def.name)) throw new Error("agent names use lowercase letters, digits and dashes, e.g. test-runner");
  const file = path.join(dir, `${def.name}.md`);
  if (fs.existsSync(file)) throw new Error(`${file} already exists`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, formatAgent(def));
  return file;
}

/**
 * Change an agent's tools, model or color in its file (undefined removes the field), leaving the
 * rest of the file as it is. In .claude/agents, tool names are written the Claude Code way.
 */
export function updateAgentFile(file: string, changes: Partial<Pick<AgentDef, "tools" | "model" | "color">>): void {
  const text = fs.readFileSync(file, "utf8");
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Error(`${file} has no frontmatter`);
  let lines = m[1].split(/\r?\n/);
  const claude = file.split(path.sep).join("/").includes("/.claude/agents/");
  for (const [key, value] of Object.entries(changes) as [string, string | string[] | undefined][]) {
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    let end = at + 1;
    while (at >= 0 && end < lines.length && /^\s/.test(lines[end])) end++; // its YAML list items
    const shown = Array.isArray(value) ? value.map((t) => (claude ? (NGOBE_TOOLS[t] ?? t) : t)).join(", ") : value;
    const line = shown === undefined ? [] : [`${key}: ${Array.isArray(value) ? shown : yamlValue(shown)}`];
    lines = at >= 0 ? [...lines.slice(0, at), ...line, ...lines.slice(end)] : [...lines, ...line];
  }
  fs.writeFileSync(file, `---\n${lines.join("\n")}\n---\n${m[2]}`);
}

function readDir(dir: string, source: AgentDef["source"]): AgentDef[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return names.flatMap((f) => {
    const file = path.join(dir, f);
    try {
      const def = parseAgent(fs.readFileSync(file, "utf8"), source, file);
      return def ? [def] : [];
    } catch {
      return [];
    }
  });
}

/** Built-in, then user, then project agents; a later definition with the same name wins. */
export function loadAgents(cwd: string, configDir: string): AgentDef[] {
  const byName = new Map<string, AgentDef>();
  for (const def of [
    ...BUILTIN_AGENTS,
    ...readDir(path.join(configDir, "agents"), "user"),
    ...readDir(path.join(cwd, ".claude", "agents"), "project"),
    ...readDir(path.join(cwd, ".ngobe", "agents"), "project"),
  ]) {
    byName.set(def.name, def);
  }
  return [...byName.values()];
}

export function agentTemplate(name: string): string {
  return `---
name: ${name}
description: One line on when to use this agent (the main agent reads it to decide)
tools: read_file, glob, grep, bash
---
You are the ${name} agent. Describe the job, how to do it well, and what the final report must contain.
`;
}

export function createAgentFile(cwd: string, name: string): string {
  if (!NAME.test(name)) throw new Error("agent names use lowercase letters, digits and dashes, e.g. test-runner");
  const file = path.join(cwd, ".ngobe", "agents", `${name}.md`);
  if (fs.existsSync(file)) throw new Error(`${path.relative(cwd, file)} already exists`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, agentTemplate(name));
  return file;
}

/** A name for a generated agent: lowercase, dashes, not one of those taken. */
export function agentName(raw: string, taken: string[]): string {
  const base =
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || "agent";
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`;
  return name;
}
