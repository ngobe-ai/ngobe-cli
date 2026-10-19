import type OpenAI from "openai";

export type Message = OpenAI.Chat.ChatCompletionMessageParam;
export type Args = Record<string, unknown>;

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
}

/** safe = read-only, write = changes files, exec = runs shell commands */
export type Risk = "safe" | "write" | "exec";

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, sent to the model as-is. */
  parameters: Record<string, unknown>;
  risk: Risk;
  /** Short human-readable summary used in permission prompts. */
  describe?(args: Args): string;
  /** Return text for the model. Throw to report an error (the message goes back to the model). */
  run(args: Args, ctx: ToolContext): Promise<string>;
}
