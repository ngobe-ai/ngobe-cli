import OpenAI from "openai";
import type { Config } from "./config.js";
import type { Message, Tool } from "./types.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string, parsed (and validated) by the agent
}
export interface AssistantTurn {
  content: string;
  toolCalls: ToolCall[];
}

/** Thin wrapper over any OpenAI-compatible /v1/chat/completions endpoint, with streaming. */
export class LLM {
  private client: OpenAI;

  constructor(private cfg: Config) {
    this.client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey });
  }

  async chat(
    messages: Message[],
    tools: Tool[],
    onText: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<AssistantTurn> {
    const toolDefs: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    const stream = await this.client.chat.completions.create(
      {
        model: this.cfg.model,
        messages,
        tools: toolDefs.length ? toolDefs : undefined,
        stream: true,
      },
      { signal },
    );

    let content = "";
    // Tool calls arrive in fragments keyed by index; stitch them back together.
    const partial = new Map<number, ToolCall>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        onText(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const cur = partial.get(tc.index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        partial.set(tc.index, cur);
      }
    }

    const toolCalls = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` })); // some servers omit ids
    return { content, toolCalls };
  }
}
