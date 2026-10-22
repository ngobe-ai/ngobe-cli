import type { AgentDef } from "./agents.js";
import type OpenAI from "openai";
import type { Config, Mode } from "./config.js";
import type { Memory } from "./memory/store.js";

export type Message = OpenAI.Chat.ChatCompletionMessageParam;
export type Args = Record<string, unknown>;

/** Content hashes of files as the agent last saw them, to catch edits made behind its back. */
export type FileTracker = Map<string, string>;

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface Todo {
  content: string;
  status: TodoStatus;
  /** Present-tense form shown while in progress: "Running the tests". */
  activeForm?: string;
}

/** A line under a tool call in the transcript: diff lines, the end of command output, a todo list. */
export interface PreviewLine {
  text: string;
  /** add/remove/context are diff lines (shown with line numbers and colored rows). */
  tone?: "add" | "remove" | "context" | "dim" | "error";
  /** Line number in the file, for diff lines. */
  line?: number;
  /** Language for syntax colors ("ts", "py", …). */
  lang?: string;
}

/** How a tool call appears in the transcript. */
export interface ToolView {
  /** Same id from start to finish. */
  id: string;
  /** Label and target, e.g. "Read" + "src/a.ts" → Read(src/a.ts). */
  label: string;
  target: string;
  state: "running" | "ok" | "error" | "declined";
  /** One line under the title: "Read 87 lines", "+2 −1", "exit 0 · 3.4s". */
  summary?: string;
  preview?: PreviewLine[];
  /** A sub-agent's color (its calls are shown in it). */
  color?: string;
}

/** An image for the model: a file read, a browser screenshot. */
export interface ToolImage {
  mime: string;
  /** Base64. */
  data: string;
}

export interface ToolContext {
  cwd: string;
  /** Show an image to the model with this call's result. Only there when the model sees images (modelSeesImages). */
  attach?(image: ToolImage): void;
  /** The user's current request (an image read for "reproduce this UI" gets a blueprint). */
  request?: string;
  /** How the call should show in the transcript, from the tool itself (an edit's real diff). */
  report?(view: { summary: string; preview?: PreviewLine[] }): void;
  signal?: AbortSignal;
  /** Present when running inside the agent; tools fall back to defaults without it. */
  config?: Config;
  files?: FileTracker;
  memory?: Memory | null;
  /** URLs web_search returned this session; fetching one of them is a signal the source was useful. */
  searchResults?: Set<string>;
  /** The agent's task list (todo_write). */
  todos?: { list: Todo[]; set(list: Todo[]): void };
  /** Ask the user something (exit_plan_mode asks to approve the plan). */
  confirm?(prompt: string): Promise<string>;
  /** Change the agent's mode for the rest of the session (after an approved plan). */
  setMode?(mode: Mode): void;
  /** Run a sub-agent on a task (fresh context) and return its final report. */
  spawn?(agent: AgentDef, prompt: string): Promise<string>;
  /** Work in a project just created (create_project); its starter files may be replaced whole. */
  enterProject?(dir: string, starter: string[]): void;
}

/**
 * What a tool can do, which decides the modes it is offered in:
 * safe = reads the project, network = reads the internet, write = changes files, exec = runs commands.
 * ask/plan modes only get safe and network tools.
 */
export type Risk = "safe" | "network" | "write" | "exec";

/**
 * Approval a specific call needs: none; approval = ask in edit mode, allowed in auto mode;
 * explicit = ask every time in every mode (destructive commands, secrets, commits).
 */
export type Need = "none" | "approval" | "explicit";

/** What a permission decision may depend on besides the arguments. */
export interface NeedContext {
  cwd: string;
  /** The user's current request: a file it names may be read even outside the project. */
  request?: string;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, sent to the model as-is and validated before every call. */
  parameters: Record<string, unknown>;
  risk: Risk;
  /** Approval for these arguments. Default: none for safe/network tools, approval for write/exec. */
  needs?(args: Args, ctx?: NeedContext): Need;
  /** Wall-clock limit for one call. Default 120s; 0 = the tool enforces its own (bash). */
  timeoutMs?: number;
  /** Short human-readable summary used in permission prompts. */
  describe?(args: Args): string;
  /** Name in the transcript, Claude Code style: Read, Edit, Bash. Default: the tool name. */
  label?: string;
  /** The main argument shown after the label: Read(src/a.ts). Default: the first string argument. */
  target?(args: Args): string;
  /** What the agent is doing while this runs, for the status line: "Reading src/a.ts". */
  activity?(args: Args): string;
  /** The result in the transcript: a one-line summary and optional preview lines. */
  summarize?(args: Args, output: string, ms: number): { summary: string; preview?: PreviewLine[] };
  /** Older argument names still accepted, e.g. { old_str: "old_string" }. */
  aliases?: Record<string, string>;
  /** Only offered in these modes (default: by risk, see toolsForMode). */
  modes?: Mode[];
  /** Shorter description and parameters for the lean profile (small local models; every token costs time). */
  lean?: { description?: string; parameters?: Record<string, unknown> };
  /** Return text for the model. Throw to report an error (the message goes back to the model). */
  run(args: Args, ctx: ToolContext): Promise<string>;
}
