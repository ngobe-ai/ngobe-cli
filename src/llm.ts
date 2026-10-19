import OpenAI from "openai";
import type { Config } from "./config.js";
import type { Message, Tool } from "./types.js";
import { parseTextToolCalls, textProtocolPrompt, toTextMessages, visibleLength } from "./toolProtocol.js";
import { ensureTunnel } from "./tunnel.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON string, parsed (and validated) by the agent
}

export interface Usage {
  input: number;
  output: number;
  /** True when the server reported no usage and these are ~4 chars/token estimates. */
  estimated: boolean;
}

export interface AssistantTurn {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage;
  model: string;
  /** Time to the first streamed token, and to the end of the response. */
  firstTokenMs: number | null;
  totalMs: number;
}

export interface ModelInfo {
  id: string;
  /** Whatever else the server reports (llama.cpp includes size, parameters and training context). */
  raw: Record<string, unknown>;
}

export class ModelTimeoutError extends Error {}

/**
 * Model gateway for any OpenAI-compatible /v1/chat/completions endpoint (Docker Model Runner,
 * llama.cpp, Ollama, vLLM, hosted providers). Streams, retries transient failures (SDK),
 * abandons a request after requestTimeout seconds of silence, falls back to the text tool
 * protocol when the endpoint refuses native tools, and to a fallback model when the main
 * one is unavailable.
 */
export class LLM {
  private client: OpenAI;
  /** Text tool protocol: configured, or switched on after the endpoint rejected native tools. */
  textTools: boolean;
  onNotice: (text: string) => void = () => {};
  private tunnel: Promise<string | null> | null = null;
  /** Set once the model makes a native tool call; until then, JSON-looking text is held back while streaming. */
  private nativeToolsSeen = false;

  constructor(private cfg: Config) {
    // The SDK timeout would cut long streams; the idle timer in attempt() bounds requests instead.
    this.client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, maxRetries: cfg.maxRetries, timeout: 60 * 60_000 });
    this.textTools = cfg.toolMode === "text";
  }

  /** Open the SSH tunnel, if one is configured, before the first request. */
  async ready(): Promise<string | null> {
    if (!this.cfg.sshTunnel) return null;
    if (!this.tunnel) {
      this.tunnel = ensureTunnel(this.cfg).then(
        (status) => {
          if (status?.includes("opened")) this.onNotice(status);
          return status;
        },
        (err) => {
          this.tunnel = null;
          throw err;
        },
      );
    }
    return this.tunnel;
  }

  async chat(messages: Message[], tools: Tool[], onText: (chunk: string) => void, signal?: AbortSignal): Promise<AssistantTurn> {
    await this.ready();
    try {
      return await this.attempt(this.cfg.model, messages, tools, onText, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      // The tunnel dropped (laptop slept, network changed, another ngobe that owned it exited): reopen once.
      if (this.cfg.sshTunnel && err instanceof OpenAI.APIConnectionError) {
        this.tunnel = null;
        await this.ready();
        return this.attempt(this.cfg.model, messages, tools, onText, signal);
      }
      if (this.cfg.toolMode === "auto" && !this.textTools && tools.length && rejectsTools(err)) {
        this.textTools = true;
        this.onNotice("The endpoint refused native tool calling; using the text tool protocol for this session.");
        return this.attempt(this.cfg.model, messages, tools, onText, signal);
      }
      const fallback = this.cfg.fallbackModel;
      if (fallback && fallback !== this.cfg.model && isUnavailable(err)) {
        this.onNotice(`${this.cfg.model} failed (${errorText(err)}); trying fallback model ${fallback}.`);
        return this.attempt(fallback, messages, tools, onText, signal);
      }
      throw err;
    }
  }

  private async attempt(
    model: string,
    messages: Message[],
    tools: Tool[],
    onText: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<AssistantTurn> {
    const text = this.textTools && tools.length > 0;
    const wire = text ? withTextProtocol(messages, tools) : messages;
    const toolDefs: OpenAI.Chat.ChatCompletionTool[] = text
      ? []
      : tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

    const idle = new AbortController();
    const idleMs = this.cfg.requestTimeout * 1000;
    let timer = setTimeout(() => idle.abort(), idleMs);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(), idleMs);
    };
    const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;

    const started = Date.now();
    let firstTokenMs: number | null = null;
    let content = "";
    let shown = 0;
    const holdJson = tools.length > 0 && !this.nativeToolsSeen;
    let usage: Usage | null = null;
    // Tool calls arrive in fragments keyed by index; stitch them back together.
    const partial = new Map<number, ToolCall>();

    try {
      const stream = await this.client.chat.completions.create(
        { model, messages: wire, tools: toolDefs.length ? toolDefs : undefined, stream: true },
        { signal: combined },
      );
      for await (const chunk of stream) {
        bump();
        if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens, estimated: false };
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if ((delta.content || delta.tool_calls) && firstTokenMs === null) firstTokenMs = Date.now() - started;

        if (delta.content) {
          content += delta.content;
          const upto = visibleLength(content, false, holdJson);
          if (upto > shown) onText(content.slice(shown, upto));
          shown = Math.max(shown, upto);
        }
        for (const tc of delta.tool_calls ?? []) {
          this.nativeToolsSeen = true;
          const cur = partial.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          partial.set(tc.index, cur);
        }
      }
    } catch (err) {
      if (idle.signal.aborted && !signal?.aborted) {
        throw new ModelTimeoutError(`${model} sent nothing for ${this.cfg.requestTimeout}s (raise NGOBE_REQUEST_TIMEOUT for slow models)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    let toolCalls = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` })); // some servers omit ids
    // Models (even with native tools on) sometimes write calls as text; accept those too.
    if (toolCalls.length === 0 && tools.length) {
      const parsed = parseTextToolCalls(content, tools.map((t) => t.name));
      if (parsed.calls.length) {
        content = parsed.content; // only the prose before the call is the reply
        toolCalls = parsed.calls.map((c, i) => ({ id: `call_${Date.now()}_${i}`, ...c }));
      }
    }
    // Show what was held back while streaming, unless it turned out to be a tool call.
    const upto = visibleLength(content, true);
    if (upto > shown) onText(content.slice(shown, upto));

    const chars = (s: string) => Math.ceil(s.length / 4);
    usage ??= {
      input:
        wire.reduce((n, m) => n + chars(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")), 0) +
        (toolDefs.length ? chars(JSON.stringify(toolDefs)) : 0),
      output: chars(content) + toolCalls.reduce((n, c) => n + chars(c.arguments), 0),
      estimated: true,
    };
    return { content, toolCalls, usage, model, firstTokenMs, totalMs: Date.now() - started };
  }

  /**
   * One tiny request: does the model answer, how fast, and does it call tools natively
   * (or write them as text, which the gateway parses)?
   */
  async probe(timeoutMs = 180_000): Promise<{ ms: number; toolCalls: "native" | "text" | "none" | "unsupported"; text: string }> {
    await this.ready();
    const started = Date.now();
    const messages: Message[] = [{ role: "user", content: "Call the ping tool now." }];
    const ping: OpenAI.Chat.ChatCompletionTool = {
      type: "function",
      function: { name: "ping", description: "Health check. Call it whenever asked to.", parameters: { type: "object", properties: {} } },
    };
    const opts = { timeout: timeoutMs, maxRetries: 0 };
    try {
      const res = await this.client.chat.completions.create({ model: this.cfg.model, messages, tools: [ping], max_tokens: 96 }, opts);
      const msg = res.choices[0]?.message;
      const text = msg?.content ?? "";
      const toolCalls = msg?.tool_calls?.length ? "native" : parseTextToolCalls(text, ["ping"]).calls.length ? "text" : "none";
      return { ms: Date.now() - started, toolCalls, text };
    } catch (err) {
      if (!rejectsTools(err)) throw err;
      const res = await this.client.chat.completions.create({ model: this.cfg.model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 8 }, opts);
      return { ms: Date.now() - started, toolCalls: "unsupported", text: res.choices[0]?.message?.content ?? "" };
    }
  }

  /** Models the endpoint serves, with whatever metadata it reports. */
  async models(timeoutMs = 10_000): Promise<ModelInfo[]> {
    await this.ready();
    const out: ModelInfo[] = [];
    for await (const m of this.client.models.list({ timeout: timeoutMs, maxRetries: 0 })) {
      out.push({ id: m.id, raw: m as unknown as Record<string, unknown> });
    }
    return out;
  }
}

/** System prompt extended with tool descriptions, and tool history rewritten as text. */
function withTextProtocol(messages: Message[], tools: Tool[]): Message[] {
  const [first, ...rest] = toTextMessages(messages);
  const protocol = textProtocolPrompt(tools);
  if (first?.role === "system" && typeof first.content === "string") {
    return [{ role: "system", content: `${first.content}\n\n${protocol}` }, ...rest];
  }
  return [{ role: "system", content: protocol }, first, ...rest].filter(Boolean) as Message[];
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** llama.cpp without --jinja, Ollama models without tool support, vLLM without auto tool choice. */
export function rejectsTools(err: unknown): boolean {
  return err instanceof OpenAI.APIError && (err.status ?? 0) >= 400 && /tool/i.test(err.message);
}

function isUnavailable(err: unknown): boolean {
  return (
    err instanceof ModelTimeoutError ||
    err instanceof OpenAI.APIConnectionError ||
    (err instanceof OpenAI.APIError && [404, 502, 503, 504].includes(err.status ?? 0))
  );
}
