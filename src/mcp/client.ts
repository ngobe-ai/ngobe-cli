import { VERSION } from "../config.js";
import type { McpServerSpec } from "./config.js";
import { HttpStatusError, HttpTransport, SseTransport, StdioTransport, type JsonRpcMessage, type Transport } from "./transport.js";

/**
 * An MCP client for one server, speaking both protocol eras:
 * - modern (2026-07-28): no handshake; every request carries the protocol version, client info
 *   and capabilities in _meta (mirrored into MCP-Protocol-Version / Mcp-Method / Mcp-Name headers
 *   on HTTP). A server/discover probe tells a modern server from an older one.
 * - legacy (2024-11-05 … 2025-11-25): an initialize handshake, then plain requests; on HTTP a
 *   session id and MCP-Protocol-Version header.
 * Ngobe declares no client capabilities (no sampling, elicitation or roots), so servers may not
 * ask it for any; it uses tools only.
 */

export const MODERN_VERSIONS = ["2026-07-28"];
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
// Errors only a modern server sends: header mismatch, missing client capability, unsupported version.
const MODERN_ERRORS = new Set([-32020, -32021, -32022]);
const UNSUPPORTED_VERSION = -32022;
// A legacy server that ignores requests before initialize is waited for this long, then initialized.
const PROBE_MS = 5_000;
const MAX_PAGES = 50;
const MAX_RESTARTS = 3;

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface McpToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface ContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  description?: string;
  resource?: { uri?: string; mimeType?: string; text?: string; blob?: string };
}

export interface CallToolResult {
  content?: ContentItem[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type Era = "modern" | "legacy";

interface Initialized {
  version: string;
  serverInfo: { name?: string; version?: string } | null;
}

/** A tool parameter mirrored into an Mcp-Param-* header (modern Streamable HTTP). */
interface HeaderParam {
  path: string[];
  header: string;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** A header value as the spec wants it: plain visible ASCII, else =?base64?…?= */
export function headerValue(v: string): string {
  const plain = /^[\x21-\x7E]([\x20-\x7E]*[\x21-\x7E])?$/.test(v) && !(v.startsWith("=?base64?") && v.endsWith("?="));
  return plain ? v : `=?base64?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

/**
 * The parameters a tool wants mirrored into headers (x-mcp-header). Only properties reachable
 * through "properties" alone, with primitive types and unique token names, may carry one; a tool
 * with any other use of it is invalid and left out (as the spec requires of HTTP clients).
 */
export function headerParams(schema: unknown): { params: HeaderParam[]; error?: string } {
  const params: HeaderParam[] = [];
  let total = 0;
  const countAll = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(countAll);
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (k === "x-mcp-header") total++;
      countAll(v);
    }
  };
  countAll(schema);
  if (!total) return { params };
  const walk = (node: Record<string, unknown>, at: string[]): string | undefined => {
    const props = node.properties;
    if (!props || typeof props !== "object") return;
    for (const [key, raw] of Object.entries(props as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const prop = raw as Record<string, unknown>;
      const header = prop["x-mcp-header"];
      if (header !== undefined) {
        if (typeof header !== "string" || !TOKEN.test(header)) return `x-mcp-header ${JSON.stringify(header)} is not a valid header name`;
        if (!["string", "integer", "boolean"].includes(String(prop.type))) return `x-mcp-header on "${[...at, key].join(".")}" needs a string, integer or boolean property`;
        if (params.some((p) => p.header.toLowerCase() === header.toLowerCase())) return `x-mcp-header "${header}" is used twice`;
        params.push({ path: [...at, key], header });
      }
      const nested = walk(prop, [...at, key]);
      if (nested) return nested;
    }
  };
  const error = schema && typeof schema === "object" ? walk(schema as Record<string, unknown>, []) : undefined;
  if (error) return { params: [], error };
  if (params.length !== total) return { params: [], error: "x-mcp-header used outside plain properties" };
  return { params };
}

function paramHeaders(params: HeaderParam[], args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params) {
    let v: unknown = args;
    for (const key of p.path) v = v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined;
    if (v === undefined || v === null) continue;
    if (typeof v === "number" && (!Number.isSafeInteger(v) || !Number.isInteger(v))) continue;
    out[`Mcp-Param-${p.header}`] = headerValue(String(v));
  }
  return out;
}

const clientInfo = () => ({ name: "ngobe", version: VERSION });

export class McpClient {
  era: Era = "modern";
  version = MODERN_VERSIONS[0];
  serverInfo: { name?: string; version?: string } | null = null;
  /** Set when a server says its tool list changed (re-read at the next session). */
  toolsChanged = false;
  private transport: Transport | null = null;
  private nextId = 1;
  private headerParams = new Map<string, HeaderParam[]>();
  private restarts = 0;
  /** A restart in progress, shared by calls that find the server gone. */
  private connecting: Promise<void> | null = null;

  constructor(
    readonly spec: McpServerSpec,
    private opts: { probeMs?: number; log?: (event: string, data: Record<string, unknown>) => void } = {},
  ) {}

  /** The end of a stdio server's stderr (for error messages). */
  get stderr(): string {
    return this.transport instanceof StdioTransport ? this.transport.stderr : "";
  }

  /** Start the server (stdio) or reach it (HTTP) and agree on a protocol version. */
  async connect(): Promise<void> {
    const signal = AbortSignal.timeout(this.spec.connectTimeoutMs);
    try {
      await this.handshake(signal);
    } catch (err) {
      await this.transport?.close().catch(() => {});
      if (signal.aborted) throw new Error(`no answer within ${Math.round(this.spec.connectTimeoutMs / 1000)}s${this.stderrHint()}`);
      throw err instanceof HttpStatusError && (err.status === 401 || err.status === 403)
        ? new Error(`${err.message}. The server needs authorization: ngobe doesn't do MCP OAuth yet, so put a token in "headers" (e.g. "Authorization": "Bearer \${TOKEN}")`)
        : new Error(`${err instanceof Error ? err.message : String(err)}${this.stderrHint()}`);
    }
  }

  private stderrHint(): string {
    const tail = this.stderr.trim().split("\n").slice(-3).join(" | ").slice(-300);
    return tail ? ` (stderr: ${tail})` : "";
  }

  private async handshake(signal: AbortSignal): Promise<void> {
    const s = this.spec;
    if (s.transport === "sse") {
      this.transport = await SseTransport.open(s.url, s.headers, signal);
      this.wire();
      return this.initialize(signal);
    }
    if (s.transport === "stdio") {
      this.transport = new StdioTransport(s.command, s.args, { cwd: s.cwd, env: s.env });
      this.wire();
      return this.probeStdio(signal);
    }
    this.transport = new HttpTransport(s.url, s.headers);
    this.wire();
    // Modern first: a 4xx without a modern JSON-RPC error means a 2025-era server.
    let answer: JsonRpcMessage & { status?: number };
    try {
      answer = await this.send("server/discover", {}, signal, "modern");
    } catch (err) {
      if (!(err instanceof HttpStatusError) || err.status === 401 || err.status === 403) throw err;
      return this.legacyHttp(signal);
    }
    if (answer.result) return this.useDiscover(answer.result, signal);
    if (answer.error && MODERN_ERRORS.has(answer.error.code)) return this.afterModernError(answer.error, signal);
    return this.legacyHttp(signal);
  }

  /** Initialize over Streamable HTTP; a server that refuses POSTs may be a 2024-11-05 HTTP+SSE one. */
  private async legacyHttp(signal: AbortSignal): Promise<void> {
    try {
      return await this.initialize(signal);
    } catch (err) {
      if (!(err instanceof HttpStatusError) || ![400, 404, 405].includes(err.status)) throw err;
      await this.transport?.close();
      this.transport = await SseTransport.open(this.spec.url, this.spec.headers, signal);
      this.wire();
      return this.initialize(signal);
    }
  }

  /**
   * On stdio: server/discover, falling back to initialize on any error that isn't a modern one.
   * A legacy server may not answer at all before initialize; after a short wait initialize goes out
   * too, and whichever handshake succeeds first decides (a slow-starting server reads both in order).
   */
  private async probeStdio(signal: AbortSignal): Promise<void> {
    type Outcome =
      | { kind: "modern"; result: Record<string, unknown> }
      | { kind: "modern-error"; error: { code: number; message: string; data?: unknown } }
      | { kind: "legacy" }
      | { kind: "init"; info: Initialized };
    const discover: Promise<Outcome> = this.send("server/discover", {}, signal, "modern").then(
      (m): Outcome => (m.result ? { kind: "modern", result: m.result } : m.error && MODERN_ERRORS.has(m.error.code) ? { kind: "modern-error", error: m.error } : { kind: "legacy" }),
      (err) => {
        if (this.transport?.closed) throw err;
        return { kind: "legacy" };
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), this.opts.probeMs ?? PROBE_MS)));
    let outcome = await Promise.race([discover, waited]);
    clearTimeout(timer);
    if (outcome === "timeout") {
      const init = this.initRequest(signal).then((info): Outcome => ({ kind: "init", info }));
      const modern = discover.then((o) => (o.kind === "legacy" ? init : o));
      outcome = await Promise.race([modern, init.catch(() => modern)]);
    }
    if (outcome.kind === "init") return this.initialized(outcome.info);
    if (outcome.kind === "modern") return this.useDiscover(outcome.result, signal);
    if (outcome.kind === "modern-error") return this.afterModernError(outcome.error, signal);
    return this.initialize(signal);
  }

  private useDiscover(result: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const supported = Array.isArray(result.supportedVersions) ? result.supportedVersions.map(String) : [];
    this.serverInfo = serverInfoOf(result);
    return this.pickVersion(supported, signal);
  }

  private afterModernError(error: { code: number; message: string; data?: unknown }, signal: AbortSignal): Promise<void> {
    if (error.code !== UNSUPPORTED_VERSION) throw new McpError(`the server refused the probe: ${error.message}`, error.code);
    const data = error.data as { supported?: unknown } | undefined;
    return this.pickVersion(Array.isArray(data?.supported) ? data.supported.map(String) : [], signal);
  }

  /** The newest version both sides speak; a legacy one means initializing after all. */
  private async pickVersion(supported: string[], signal: AbortSignal): Promise<void> {
    const modern = MODERN_VERSIONS.find((v) => supported.includes(v));
    if (modern) {
      this.era = "modern";
      this.version = modern;
      return;
    }
    const legacy = LEGACY_VERSIONS.find((v) => supported.includes(v));
    if (!legacy) throw new McpError(`no protocol version in common (the server speaks ${supported.join(", ") || "none it named"}; ngobe ${[...MODERN_VERSIONS, ...LEGACY_VERSIONS].join(", ")})`);
    return this.initialize(signal, legacy);
  }

  private async initialize(signal: AbortSignal, version = LEGACY_VERSIONS[0]): Promise<void> {
    return this.initialized(await this.initRequest(signal, version));
  }

  /** The initialize request alone (no state changes: during the stdio probe it may lose the race). */
  private async initRequest(signal: AbortSignal, version = LEGACY_VERSIONS[0]): Promise<Initialized> {
    const m = await this.send("initialize", { protocolVersion: version, capabilities: {}, clientInfo: clientInfo() }, signal, "legacy");
    if (m.error) throw new McpError(`initialize failed: ${m.error.message}`, m.error.code, m.error.data);
    const agreed = String(m.result?.protocolVersion ?? "");
    if (!LEGACY_VERSIONS.includes(agreed)) throw new McpError(`the server wants protocol version ${agreed || "(none)"}, which ngobe doesn't speak`);
    return { version: agreed, serverInfo: (m.result?.serverInfo as Initialized["serverInfo"]) ?? null };
  }

  private async initialized(info: Initialized): Promise<void> {
    this.era = "legacy";
    this.version = info.version;
    this.serverInfo = info.serverInfo;
    await this.transport!.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, this.legacyHeaders());
  }

  private legacyHeaders(): Record<string, string> | undefined {
    return this.transport instanceof HttpTransport && this.era === "legacy" && this.version !== "2024-11-05" ? { "MCP-Protocol-Version": this.version } : undefined;
  }

  /** Server-initiated traffic: answer pings, refuse what ngobe doesn't offer, note list changes. */
  private wire(): void {
    const t = this.transport!;
    t.onMessage = (msg) => {
      if (msg.id !== undefined && msg.id !== null && msg.method) {
        const answer: JsonRpcMessage =
          msg.method === "ping" ? { jsonrpc: "2.0", id: msg.id, result: {} } : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `ngobe does not support ${msg.method}` } };
        void t.respond(answer, this.legacyHeaders()).catch(() => {});
        return;
      }
      if (msg.method === "notifications/tools/list_changed") {
        this.toolsChanged = true;
        this.opts.log?.("mcp_tools_changed", { server: this.spec.name });
      }
    };
  }

  /** One request, shaped for the era. Returns the response message (result or error). */
  private async send(method: string, params: Record<string, unknown>, signal: AbortSignal, era: Era, extraHeaders?: Record<string, string>): Promise<JsonRpcMessage & { status?: number }> {
    const id = this.nextId++;
    const body: Record<string, unknown> = { ...params };
    let headers: Record<string, string> | undefined;
    if (era === "modern") {
      const version = method === "server/discover" ? MODERN_VERSIONS[0] : this.version;
      body._meta = {
        ...((params._meta as Record<string, unknown>) ?? {}),
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientInfo": clientInfo(),
        "io.modelcontextprotocol/clientCapabilities": {},
      };
      if (this.transport instanceof HttpTransport) {
        const name = typeof params.name === "string" ? params.name : typeof params.uri === "string" ? params.uri : null;
        headers = { "MCP-Protocol-Version": version, "Mcp-Method": method, ...(name !== null ? { "Mcp-Name": headerValue(name) } : {}), ...extraHeaders };
      }
    } else if (method !== "initialize") headers = this.legacyHeaders();
    return this.transport!.request({ jsonrpc: "2.0", id, method, params: body }, { signal, headers });
  }

  /** A request after connecting, restarting a stdio server that died and renewing an expired session. */
  private async call(method: string, params: Record<string, unknown>, signal: AbortSignal, extraHeaders?: Record<string, string>): Promise<Record<string, unknown>> {
    if (this.transport?.closed && this.transport.closed !== "closed") await this.reconnect();
    // A 404 to a request with a 2025-era session id: the server forgot the session (it restarted).
    const expired = (status: number | undefined) => status === 404 && this.era === "legacy" && this.transport instanceof HttpTransport && !!this.transport.sessionId;
    let m: JsonRpcMessage & { status?: number };
    try {
      m = await this.send(method, params, signal, this.era, extraHeaders);
    } catch (err) {
      if (err instanceof HttpStatusError && expired(err.status)) m = { jsonrpc: "2.0", status: 404 };
      else if (this.transport?.closed && this.transport.closed !== "closed" && !signal.aborted && this.restarts < MAX_RESTARTS) {
        await this.reconnect();
        m = await this.send(method, params, signal, this.era, extraHeaders);
      } else throw err;
    }
    if (expired(m.status)) {
      (this.transport as HttpTransport).sessionId = null;
      await this.initialize(signal, this.version);
      m = await this.send(method, params, signal, this.era, extraHeaders);
    }
    if (m.error) throw new McpError(m.error.message, m.error.code, m.error.data);
    const result = m.result ?? {};
    const type = result.resultType;
    if (type === undefined || type === "complete") return result;
    if (type === "input_required") {
      const asked = Object.values((result.inputRequests as Record<string, { method?: string }>) ?? {}).map((r) => r?.method ?? "input");
      throw new McpError(`the server asked for ${[...new Set(asked)].join(", ") || "more input"}, which ngobe can't provide`);
    }
    throw new McpError(`unexpected result type "${String(type)}"`);
  }

  /** Start a stdio server again after it exited (at most a few times a session). */
  private async reconnect(): Promise<void> {
    if (this.restarts >= MAX_RESTARTS) throw new Error(`${this.transport?.closed ?? "not connected"} (restarted ${MAX_RESTARTS} times already)`);
    this.restarts++;
    this.opts.log?.("mcp_restart", { server: this.spec.name, reason: (this.transport?.closed ?? "").slice(0, 200) });
    this.connecting ??= this.connect().finally(() => (this.connecting = null));
    await this.connecting;
  }

  /** Every tool, page by page. Tools with a broken x-mcp-header are left out (and reported). */
  async listTools(signal = AbortSignal.timeout(this.spec.connectTimeoutMs)): Promise<{ tools: McpToolDef[]; rejected: string[] }> {
    const tools: McpToolDef[] = [];
    const rejected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.call("tools/list", cursor ? { cursor } : {}, signal);
      for (const raw of Array.isArray(result.tools) ? (result.tools as McpToolDef[]) : []) {
        if (!raw || typeof raw.name !== "string" || !raw.name) continue;
        if (this.era === "modern" && this.transport instanceof HttpTransport) {
          const h = headerParams(raw.inputSchema);
          if (h.error) {
            rejected.push(`${raw.name}: ${h.error}`);
            continue;
          }
          if (h.params.length) this.headerParams.set(raw.name, h.params);
        }
        tools.push(raw);
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return { tools, rejected };
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    const extra = this.era === "modern" ? paramHeaders(this.headerParams.get(name) ?? [], args) : undefined;
    return (await this.call("tools/call", { name, arguments: args }, signal, extra)) as CallToolResult;
  }

  async close(): Promise<void> {
    await this.transport?.close().catch(() => {});
  }
}

function serverInfoOf(result: Record<string, unknown>): { name?: string; version?: string } | null {
  const meta = result._meta as Record<string, unknown> | undefined;
  const info = (meta?.["io.modelcontextprotocol/serverInfo"] ?? result.serverInfo) as { name?: string; version?: string } | undefined;
  return info && typeof info === "object" ? info : null;
}
