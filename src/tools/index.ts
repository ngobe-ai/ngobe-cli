import type { AgentDef } from "../agents.js";
import type { Config } from "../config.js";
import type { Tool } from "../types.js";
import { bash, bashOutput, killShell } from "./bash.js";
import { editFile, multiEdit } from "./editFile.js";
import { gitTools } from "./git.js";
import { glob } from "./glob.js";
import { grep } from "./grep.js";
import { infoTools, webSearchTool } from "./info.js";
import { remember } from "./memory.js";
import { exitPlanMode, todoWrite } from "./plan.js";
import { taskTool } from "./task.js";
import { readFile } from "./readFile.js";
import { writeFile } from "./writeFile.js";

// Add a tool = write one file exporting a Tool, then list it here.
export const coreTools: Tool[] = [
  readFile,
  editFile,
  multiEdit,
  writeFile,
  glob,
  grep,
  bash,
  bashOutput,
  killShell,
  todoWrite,
  exitPlanMode,
  ...gitTools,
  ...infoTools,
];

/**
 * The lean profile: what a small model on a CPU needs, nothing more. Every tool definition is
 * re-read on a cold start (~15 tokens/s on a 6-core VPS), and a 7B model picks better among
 * fewer tools. Everything else (git, todos, background shells, multi-edit…) is in "full".
 */
const LEAN = new Set([
  "read_file",
  "edit_file",
  "write_file",
  "glob",
  "grep",
  "bash",
  "git_status", // ask and plan modes have no bash: without these the model can't see what changed
  "git_diff",
  "check_latest_version",
  "get_release_notes",
  "search_security_advisories",
  "fetch_url",
  "web_search",
  "exit_plan_mode",
]);

/**
 * Every tool available with this configuration: web_search needs a provider, remember needs
 * memory. Sub-agents (task) come with the full profile, or in lean once the project or user
 * defines a custom agent, which is the user asking for them.
 */
export function buildTools(config: Config, opts: { memory: boolean; agents?: AgentDef[] }): Tool[] {
  const agents = opts.agents ?? [];
  const full = config.toolProfile === "full";
  const task = agents.length && (full || agents.some((a) => a.source !== "built-in")) ? [taskTool(agents)] : [];
  const all = [...coreTools, ...(config.searchProviders.length ? [webSearchTool] : []), ...(opts.memory ? [remember] : []), ...task];
  if (full) return all;
  return all.filter((t) => LEAN.has(t.name) || t.name === "task").map((t) => (t.lean ? { ...t, ...t.lean } : t));
}
