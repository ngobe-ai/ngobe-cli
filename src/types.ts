import type OpenAI from "openai";
import type { Config } from "./config.js";
import type { Memory } from "./memory/store.js";

export type Message = OpenAI.Chat.ChatCompletionMessageParam;
export type Args = Record<string, unknown>;

/** Content hashes of files as the agent last saw them, to catch edits made behind its back. */
export type FileTracker = Map<string, string>;

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  /** Present when running inside the agent; tools fall back to defaults without it. */
  config?: Config;
  files?: FileTracker;
  memory?: Memory | null;
  /** URLs web_search returned this session; fetching one of them is a signal the source was useful. */
  searchResults?: Set<string>;
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

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, sent to the model as-is and validated before every call. */
  parameters: Record<string, unknown>;
  risk: Risk;
  /** Approval for these arguments. Default: none for safe/network tools, approval for write/exec. */
  needs?(args: Args): Need;
  /** Wall-clock limit for one call. Default 120s; 0 = the tool enforces its own (bash). */
  timeoutMs?: number;
  /** Short human-readable summary used in the transcript and permission prompts. */
  describe?(args: Args): string;
  /** Return text for the model. Throw to report an error (the message goes back to the model). */
  run(args: Args, ctx: ToolContext): Promise<string>;
}
