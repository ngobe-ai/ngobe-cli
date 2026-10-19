import type { Config } from "./config.js";
import type { LLM } from "./llm.js";
import type { Permissions } from "./permissions.js";
import type { Args, Message, Tool } from "./types.js";
import type { Ui } from "./ui.js";
import { trimHistory, truncate } from "./context.js";

interface AgentDeps {
  config: Config;
  llm: LLM;
  tools: Tool[];
  ui: Ui;
  perms: Permissions;
  systemPrompt: string;
}

export class Agent {
  private messages: Message[] = [];

  constructor(private d: AgentDeps) {}

  reset() {
    this.messages = [];
  }

  /** One user request: loop model -> tools -> model until the model answers without tool calls. */
  async run(userInput: string, signal: AbortSignal): Promise<void> {
    const { config, llm, tools, ui, perms, systemPrompt } = this.d;
    const byName = new Map(tools.map((t) => [t.name, t]));
    this.messages.push({ role: "user", content: userInput });

    for (let turn = 0; turn < config.maxTurns; turn++) {
      trimHistory(this.messages, config.maxContextChars);

      const result = await llm.chat(
        [{ role: "system", content: systemPrompt }, ...this.messages],
        tools,
        (chunk) => ui.write(chunk),
        signal,
      );
      ui.endTurn();

      this.messages.push({
        role: "assistant",
        content: result.content || null,
        tool_calls: result.toolCalls.length
          ? result.toolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: c.arguments },
            }))
          : undefined,
      });

      if (result.toolCalls.length === 0) return; // done

      for (const call of result.toolCalls) {
        const output = signal.aborted
          ? "Cancelled by user."
          : await this.execute(call.name, call.arguments, byName, signal);
        // Every tool_call needs a matching tool message, even when cancelled.
        this.messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }
      if (signal.aborted) return;
    }
    ui.warn(`Stopped after ${config.maxTurns} turns.`);
  }

  private async execute(
    name: string,
    rawArgs: string,
    byName: Map<string, Tool>,
    signal: AbortSignal,
  ): Promise<string> {
    const { ui, perms, config } = this.d;

    const tool = byName.get(name);
    if (!tool) return `Error: unknown tool "${name}". Available: ${[...byName.keys()].join(", ")}`;

    let args: Args;
    try {
      const parsed: unknown = JSON.parse(rawArgs || "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      args = parsed as Args;
    } catch {
      return `Error: arguments for ${name} were not a valid JSON object. Retry with valid JSON.`;
    }

    ui.tool(tool.describe?.(args) ?? name);
    if (!(await perms.check(tool, args))) return "Error: the user denied this action.";
    if (signal.aborted) return "Cancelled by user."; // Ctrl+C while the prompt was open

    try {
      return truncate(await tool.run(args, { cwd: config.cwd, signal }));
    } catch (err) {
      // Error text goes back to the model so it can correct itself.
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
