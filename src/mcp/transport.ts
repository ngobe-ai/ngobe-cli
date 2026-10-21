import { spawn, type ChildProcess } from "node:child_process";
import { childEnv } from "../childEnv.js";

/**
 * The three ways to reach an MCP server: a subprocess speaking newline-delimited JSON-RPC on its
 * standard streams (stdio), one HTTP POST per message answered with JSON or an SSE stream
 * (Streamable HTTP), and the deprecated 2024-11-05 HTTP+SSE transport (a GET event stream for
 * replies, POSTs to the endpoint it names). They only move messages; client.ts speaks MCP.
 */

export type JsonRpcId = number | string;
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}
export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: JsonRpcError;
}

/** An HTTP answer that wasn't a JSON-RPC message (a 404 page, a 401 from a gateway…). */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}${body.trim() ? `: ${body.trim().replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  }
}

export interface Transport {
  /** The response to a request (a result or an error message). Throws if the server can't be reached. */
  request(msg: JsonRpcMessage, opts: { signal: AbortSignal; headers?: Record<string, string> }): Promise<JsonRpcMessage & { status?: number }>;
  notify(msg: JsonRpcMessage, headers?: Record<string, string>): Promise<void>;
  /** Answer a request the server sent (2025-era servers ping, or ask for roots). */
  respond(msg: JsonRpcMessage, headers?: Record<string, string>): Promise<void>;
  /** Server-initiated messages: notifications, and requests to answer with respond(). */
  onMessage: (msg: JsonRpcMessage) => void;
  /** Set once the connection is gone for good (the process exited…), with the reason. */
  closed: string | null;
  close(): Promise<void>;
}

const isResponse = (m: JsonRpcMessage) => m.id !== undefined && m.id !== null && !m.method && ("result" in m || "error" in m);

// --- stdio --------------------------------------------------------------------------------------

const STDERR_KEEP = 4_000;
const running = new Set<ChildProcess>();
let exitHook = false;

/** Kill a server's whole process group (npx and the node it started). */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

export class StdioTransport implements Transport {
  onMessage: (msg: JsonRpcMessage) => void = () => {};
  closed: string | null = null;
  /** The end of the server's stderr, for error messages. */
  stderr = "";
  private child: ChildProcess;
  private pending = new Map<JsonRpcId, (m: JsonRpcMessage) => void>();
  private failPending: ((reason: string) => void)[] = [];
  private buffer = "";
  private exited: Promise<void>;

  constructor(command: string, args: string[], opts: { cwd: string; env: Record<string, string> }) {
    // Its own process group, so closing kills everything it started; ngobe's credentials stay out
    // of its environment unless the server's "env" passes them on (${GITHUB_TOKEN}).
    this.child = spawn(command, args, { cwd: opts.cwd, env: { ...childEnv(), ...opts.env }, stdio: ["pipe", "pipe", "pipe"], detached: true });
    running.add(this.child);
    if (!exitHook) {
      exitHook = true;
      process.on("exit", () => {
        for (const c of running) killTree(c, "SIGKILL");
      });
    }
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP);
    });
    this.child.stdin!.on("error", () => {}); // EPIPE once it has exited: reported through "exit"
    this.exited = new Promise((resolve) => {
      const done = (reason: string) => {
        running.delete(this.child);
        if (!this.closed) this.closed = reason;
        for (const fail of this.failPending.splice(0)) fail(this.closed);
        resolve();
      };
      this.child.on("error", (err) => done(`could not start ${command}: ${err.message}`));
      this.child.on("exit", (code, signal) => {
        const tail = this.stderr.trim().split("\n").slice(-5).join("\n").slice(-600);
        done(`the server exited (${signal ?? `code ${code}`})${tail ? `: ${tail}` : ""}`);
      });
    });
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        this.stderr = (this.stderr + `[stdout] ${line}\n`).slice(-STDERR_KEEP); // not MCP: keep it for errors
        continue;
      }
      if (isResponse(msg)) this.pending.get(msg.id!)?.(msg);
      else if (msg.method) this.onMessage(msg);
    }
  }

  private write(msg: JsonRpcMessage): void {
    if (this.closed) throw new Error(this.closed);
    this.child.stdin!.write(`${JSON.stringify(msg)}\n`);
  }

  request(msg: JsonRpcMessage, opts: { signal: AbortSignal }): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      const id = msg.id!;
      const cleanup = () => {
        this.pending.delete(id);
        this.failPending = this.failPending.filter((f) => f !== fail);
        opts.signal.removeEventListener("abort", onAbort);
      };
      const fail = (reason: string) => {
        cleanup();
        reject(new Error(reason));
      };
      const onAbort = () => {
        cleanup();
        // stdio has no per-request stream to close: cancellation is a notification.
        if (!this.closed) this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: String(opts.signal.reason?.message ?? "cancelled") } });
        reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("cancelled"));
      };
      if (opts.signal.aborted) return reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("cancelled"));
      this.pending.set(id, (m) => {
        cleanup();
        resolve(m);
      });
      this.failPending.push(fail);
      opts.signal.addEventListener("abort", onAbort, { once: true });
      try {
        this.write(msg);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async notify(msg: JsonRpcMessage): Promise<void> {
    this.write(msg);
  }

  async respond(msg: JsonRpcMessage): Promise<void> {
    this.write(msg);
  }

  /** Close its input, give it a moment to exit, then end the process group. */
  async close(): Promise<void> {
    if (!this.closed) this.closed = "closed";
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin!.end();
    const waited = (ms: number) => Promise.race([this.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
    if (await waited(1_000)) return;
    killTree(this.child, "SIGTERM");
    if (await waited(1_000)) return;
    killTree(this.child, "SIGKILL");
  }
}

// --- HTTP ---------------------------------------------------------------------------------------

// Bun's fetch gives up after 5 minutes; a long tool call (a browser test) may take longer.
const fetchNoLimit = ((url: RequestInfo | URL, init?: RequestInit) => fetch(url, { ...init, timeout: false } as RequestInit)) as typeof fetch;

/** Messages in an SSE body: each event's data lines joined, parsed as JSON-RPC. */
async function* sseMessages(body: ReadableStream<Uint8Array>, events?: (event: string, data: string) => boolean): AsyncGenerator<JsonRpcMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue; // a comment (keep-alive)
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
        if (!data.length) continue;
        if (events?.(event, data.join("\n"))) continue;
        if (event !== "message") continue;
        try {
          yield JSON.parse(data.join("\n")) as JsonRpcMessage;
        } catch {
          // not JSON: skip it
        }
      }
    }
  } finally {
    reader.releaseLock();
    body.cancel().catch(() => {});
  }
}

/** A JSON-RPC message in an error body, if there is one. */
function jsonRpcIn(text: string): JsonRpcMessage | null {
  try {
    const m = JSON.parse(text) as JsonRpcMessage;
    return m && typeof m === "object" && (m.error || m.result) ? m : null;
  } catch {
    return null;
  }
}

/**
 * Streamable HTTP. Each message is its own POST; a request is answered with one JSON object or an
 * SSE stream carrying related notifications and then the response. The 2025 revisions also had a
 * session (Mcp-Session-Id, ended with DELETE), kept here once a server hands one out.
 */
export class HttpTransport implements Transport {
  onMessage: (msg: JsonRpcMessage) => void = () => {};
  closed: string | null = null;
  sessionId: string | null = null;

  constructor(
    readonly url: string,
    private headers: Record<string, string>,
  ) {}

  private post(msg: JsonRpcMessage, headers: Record<string, string> | undefined, signal?: AbortSignal): Promise<Response> {
    return fetchNoLimit(this.url, {
      method: "POST",
      headers: {
        ...this.headers,
        ...headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify(msg),
      signal,
    });
  }

  async request(msg: JsonRpcMessage, opts: { signal: AbortSignal; headers?: Record<string, string> }): Promise<JsonRpcMessage & { status?: number }> {
    if (this.closed) throw new Error(this.closed);
    const res = await this.post(msg, opts.headers, opts.signal);
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const rpc = jsonRpcIn(text);
      if (rpc?.error) return { ...rpc, status: res.status };
      throw new HttpStatusError(res.status, text);
    }
    if (type.includes("text/event-stream") && res.body) {
      for await (const m of sseMessages(res.body)) {
        if (isResponse(m) && m.id === msg.id) return m;
        if (m.method) this.onMessage(m);
      }
      throw new Error("the server closed the event stream without answering");
    }
    const text = await res.text();
    const rpc = jsonRpcIn(text);
    if (!rpc) throw new Error(`the server's answer was not a JSON-RPC response (${type || "no content type"}, HTTP ${res.status})`);
    return rpc;
  }

  async notify(msg: JsonRpcMessage, headers?: Record<string, string>): Promise<void> {
    const res = await this.post(msg, headers);
    await res.body?.cancel().catch(() => {});
    if (!res.ok) throw new HttpStatusError(res.status, "");
  }

  respond(msg: JsonRpcMessage, headers?: Record<string, string>): Promise<void> {
    return this.notify(msg, headers);
  }

  /** End the 2025-era session, if there is one (best effort). */
  async close(): Promise<void> {
    this.closed = "closed";
    if (!this.sessionId) return;
    const session = this.sessionId;
    this.sessionId = null;
    await fetchNoLimit(this.url, { method: "DELETE", headers: { ...this.headers, "Mcp-Session-Id": session }, signal: AbortSignal.timeout(2_000) })
      .then((r) => r.body?.cancel())
      .catch(() => {});
  }
}

/**
 * The deprecated HTTP+SSE transport (2024-11-05): a GET opens an event stream whose first event
 * names the endpoint to POST messages to; every reply comes back on that stream.
 */
export class SseTransport implements Transport {
  onMessage: (msg: JsonRpcMessage) => void = () => {};
  closed: string | null = null;
  private endpoint = "";
  private pending = new Map<JsonRpcId, (m: JsonRpcMessage) => void>();
  private failPending: ((reason: string) => void)[] = [];
  private stream = new AbortController();

  private constructor(
    readonly url: string,
    private headers: Record<string, string>,
  ) {}

  /** Open the event stream and wait for the endpoint event; `signal` limits only the opening. */
  static async open(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<SseTransport> {
    const t = new SseTransport(url, headers);
    const onAbort = () => t.stream.abort(new Error("no endpoint event from the server in time"));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await fetchNoLimit(url, { headers: { ...headers, Accept: "text/event-stream" }, signal: t.stream.signal });
      if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const text = await res.text().catch(() => "");
        throw new HttpStatusError(res.status, res.ok ? "not an event stream" : text);
      }
      let found: (endpoint: string) => void = () => {};
      const endpoint = new Promise<string>((resolve) => (found = resolve));
      const messages = sseMessages(res.body, (event, data) => {
        if (event !== "endpoint") return false;
        found(new URL(data.trim(), url).toString());
        return true;
      });
      const reading = (async () => {
        try {
          for await (const m of messages) {
            if (isResponse(m)) t.pending.get(m.id!)?.(m);
            else if (m.method) t.onMessage(m);
          }
          t.end("the server closed the event stream");
        } catch (err) {
          t.end(t.closed ?? `the event stream failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      const ep = await Promise.race([endpoint, reading.then(() => Promise.reject(new Error(t.closed ?? "the event stream ended before naming an endpoint")))]);
      if (new URL(ep).origin !== new URL(url).origin) {
        t.stream.abort();
        throw new Error(`the server named an endpoint on another origin (${new URL(ep).origin}); refusing to send it messages`);
      }
      t.endpoint = ep;
      return t;
    } catch (err) {
      t.stream.abort();
      throw signal.aborted ? new Error("no endpoint event from the server in time") : err;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private end(reason: string): void {
    if (!this.closed) this.closed = reason;
    for (const fail of this.failPending.splice(0)) fail(this.closed);
  }

  private async post(msg: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    const res = await fetchNoLimit(this.endpoint, { method: "POST", headers: { ...this.headers, "Content-Type": "application/json" }, body: JSON.stringify(msg), signal });
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new HttpStatusError(res.status, text);
  }

  request(msg: JsonRpcMessage, opts: { signal: AbortSignal }): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error(this.closed));
      const id = msg.id!;
      const cleanup = () => {
        this.pending.delete(id);
        this.failPending = this.failPending.filter((f) => f !== fail);
        opts.signal.removeEventListener("abort", onAbort);
      };
      const fail = (reason: string) => {
        cleanup();
        reject(new Error(reason));
      };
      const onAbort = () => {
        cleanup();
        void this.post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } }).catch(() => {});
        reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("cancelled"));
      };
      this.pending.set(id, (m) => {
        cleanup();
        resolve(m);
      });
      this.failPending.push(fail);
      opts.signal.addEventListener("abort", onAbort, { once: true });
      this.post(msg, opts.signal).catch((err) => fail(err instanceof Error ? err.message : String(err)));
    });
  }

  notify(msg: JsonRpcMessage): Promise<void> {
    return this.post(msg);
  }

  respond(msg: JsonRpcMessage): Promise<void> {
    return this.post(msg);
  }

  async close(): Promise<void> {
    this.end("closed");
    this.stream.abort();
  }
}
