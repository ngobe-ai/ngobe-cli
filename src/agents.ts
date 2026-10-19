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
 *   ---
 *   You run the project's tests…
 *
 * Read from .ngobe/agents/ (project), ~/.config/ngobe/agents/ (user) and .claude/agents/
 * (project, for compatibility; Claude Code tool names are mapped to ngobe's).
 */

export interface AgentDef {
  name: string;
  description: string;
  /** Tool names it may use; undefined = every tool the main agent has (except task). */
  tools?: string[];
  prompt: string;
  source: "built-in" | "project" | "user";
  path?: string;
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

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function parseAgent(text: string, source: AgentDef["source"], file?: string): AgentDef | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  const name = meta.name?.toLowerCase();
  if (!name || !NAME.test(name) || !meta.description) return null;
  const tools = meta.tools
    ? meta.tools
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => CLAUDE_TOOLS[t] ?? t)
    : undefined;
  return { name, description: meta.description, tools, prompt: m[2].trim(), source, path: file };
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
