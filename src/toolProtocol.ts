import type { Message, Tool } from "./types.js";

/**
 * Tool calling for endpoints or models without native support: the tools are described in
 * the system prompt and the model writes <tool_call> blocks, which are parsed and then
 * validated exactly like native calls. Nothing here executes anything.
 */

export function textProtocolPrompt(tools: Tool[]): string {
  const specs = tools
    .map((t) => `- ${t.name}: ${t.description}\n  arguments (JSON Schema): ${JSON.stringify(t.parameters)}`)
    .join("\n");
  return `# Tools
To call a tool, write a block like this (one block per call; several blocks are allowed):
<tool_call>
{"name": "read_file", "arguments": {"path": "src/index.ts"}}
</tool_call>
Then stop and wait: results come back in <tool_result> blocks. Use only these tools and argument names:
${specs}`;
}

export interface TextToolCall {
  name: string;
  /** Raw JSON string, validated by the agent like a native call. */
  arguments: string;
}

const BLOCK = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;

/**
 * Extract tool calls written as text: the JSON form used by Hermes/Qwen 2.5 templates
 * (<tool_call>{"name": …, "arguments": {…}}</tool_call>) and the Qwen3-Coder XML form
 * (<tool_call><function=name><parameter=key>value</parameter></function></tool_call>).
 * A block that can't be parsed still becomes a call with its raw text as arguments, so
 * the model is told it was malformed instead of the call vanishing.
 */
export function parseTextToolCalls(text: string): { content: string; calls: TextToolCall[] } {
  const calls: TextToolCall[] = [];
  for (const m of text.matchAll(BLOCK)) {
    const body = m[1].trim();
    if (body) calls.push(parseBlock(body));
  }
  return { content: text.replace(BLOCK, "").trim(), calls };
}

function parseBlock(body: string): TextToolCall {
  const fn = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/.exec(body);
  if (fn) {
    const args: Record<string, string> = {};
    for (const p of fn[2].matchAll(/<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) args[p[1]] = p[2];
    return { name: fn[1], arguments: JSON.stringify(args) };
  }
  try {
    const parsed = JSON.parse(body) as { name?: unknown; arguments?: unknown; parameters?: unknown };
    const args = parsed.arguments ?? parsed.parameters ?? {};
    return { name: String(parsed.name ?? ""), arguments: typeof args === "string" ? args : JSON.stringify(args) };
  } catch {
    return { name: /"name"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? "", arguments: body };
  }
}

/** Rewrite native tool-call history as plain text, merging consecutive messages of the same role. */
export function toTextMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    let next: Message = m;
    if (m.role === "assistant" && m.tool_calls?.length) {
      const blocks = m.tool_calls.flatMap((c) =>
        c.type === "function"
          ? [`<tool_call>\n{"name": ${JSON.stringify(c.function.name)}, "arguments": ${c.function.arguments || "{}"}}\n</tool_call>`]
          : [],
      );
      next = { role: "assistant", content: [typeof m.content === "string" ? m.content : "", ...blocks].filter(Boolean).join("\n") };
    } else if (m.role === "tool") {
      next = { role: "user", content: `<tool_result>\n${typeof m.content === "string" ? m.content : ""}\n</tool_result>` };
    }
    const prev = out[out.length - 1];
    if (prev && prev.role === next.role && (next.role === "user" || next.role === "assistant") && typeof prev.content === "string" && typeof next.content === "string") {
      out[out.length - 1] = { ...prev, content: `${prev.content}\n\n${next.content}` } as Message;
    } else {
      out.push(next);
    }
  }
  return out;
}

const TAG = "<tool_call";

/**
 * How much of streamed text is safe to show: everything before a <tool_call> block, holding
 * back a trailing fragment that might be the start of one ("<to…").
 */
export function visibleLength(content: string, final: boolean): number {
  const cut = content.indexOf(TAG);
  if (cut >= 0) return cut;
  if (final) return content.length;
  for (let k = Math.min(TAG.length - 1, content.length); k > 0; k--) {
    if (TAG.startsWith(content.slice(-k))) return content.length - k;
  }
  return content.length;
}
