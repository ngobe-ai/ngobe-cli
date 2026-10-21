import { configFilePath, type Config } from "../config.js";
import { redact } from "../log.js";
import type { Tool } from "../types.js";
import { McpClient, type Era } from "./client.js";
import { loadServers, type McpScope, type McpServerSpec, type McpTransport } from "./config.js";
import { toTool } from "./tools.js";

export interface McpServerStatus {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  /** "command args" or the URL, for display. */
  target: string;
  state: "connected" | "failed" | "disabled";
  tools: string[];
  era?: Era;
  version?: string;
  server?: string;
  ms?: number;
  error?: string;
  /** Tools the server offered that ngobe left out, and why. */
  rejected?: string[];
  /** About how many prompt tokens its tool definitions add to every request (re-read on a cold start). */
  promptTokens?: number;
}

/** Rough token count of tool definitions as the model gets them (~4 characters a token). */
export function promptTokens(tools: Pick<Tool, "name" | "description" | "parameters">[]): number {
  return Math.round(tools.reduce((n, t) => n + t.name.length + t.description.length + JSON.stringify(t.parameters).length + 30, 0) / 4);
}

type Log = (event: string, data: Record<string, unknown>) => void;

export function targetOf(s: McpServerSpec): string {
  return s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url.replace(/\?.*$/, "");
}

/** The configured servers for this folder (the project's .mcp.json only when it is trusted). */
export function serversFor(config: Config, trusted: boolean) {
  return loadServers({
    user: config.mcpServers,
    userFile: configFilePath(),
    cwd: config.cwd,
    trusted,
    defaults: { connectTimeoutMs: config.mcpTimeout * 1000, toolTimeoutMs: config.mcpToolTimeout * 1000, env: process.env },
  });
}

/** Connect to one server and list its tools; never throws (a failure is a status). */
export async function connectServer(spec: McpServerSpec, opts: { log?: Log; probeMs?: number; lean?: boolean } = {}): Promise<{ client: McpClient | null; status: McpServerStatus; defs: Awaited<ReturnType<McpClient["listTools"]>>["tools"] }> {
  const status: McpServerStatus = { name: spec.name, scope: spec.scope, transport: spec.transport, target: targetOf(spec), state: "disabled", tools: [] };
  if (spec.disabled) return { client: null, status, defs: [] };
  if (spec.error) return { client: null, status: { ...status, state: "failed", error: spec.error }, defs: [] };
  const started = Date.now();
  const client = new McpClient(spec, { log: opts.log, probeMs: opts.probeMs });
  try {
    await client.connect();
    const { tools, rejected } = await client.listTools();
    const defs = spec.allow ? tools.filter((t) => spec.allow!.has(t.name)) : tools;
    defs.sort((a, b) => a.name.localeCompare(b.name));
    const server = client.serverInfo?.name ? `${client.serverInfo.name}${client.serverInfo.version ? ` ${client.serverInfo.version}` : ""}` : undefined;
    const done = {
      ...status,
      state: "connected" as const,
      tools: defs.map((d) => d.name),
      era: client.era,
      version: client.version,
      server,
      ms: Date.now() - started,
      promptTokens: promptTokens(defs.map((d) => toTool(client, d, opts.lean ?? true))),
      ...(rejected.length ? { rejected } : {}),
    };
    opts.log?.("mcp_connect", { server: spec.name, transport: spec.transport, era: client.era, version: client.version, tools: defs.length, ms: done.ms, ok: true });
    return { client, status: done, defs };
  } catch (err) {
    await client.close();
    const error = redact(err instanceof Error ? err.message : String(err));
    opts.log?.("mcp_connect", { server: spec.name, transport: spec.transport, ms: Date.now() - started, ok: false, error: error.slice(0, 300) });
    return { client: null, status: { ...status, state: "failed", error, ms: Date.now() - started }, defs: [] };
  }
}

/**
 * The session's MCP servers: all connected in parallel at the start (a failure is a warning, never
 * a stop), their tools in a fixed order (server, then tool name) so the prompt prefix the model
 * server caches stays the same from one session to the next.
 */
export class McpManager {
  private constructor(
    readonly servers: McpServerStatus[],
    readonly tools: Tool[],
    private clients: McpClient[],
    /** Names in an untrusted folder's .mcp.json that were not started. */
    readonly untrusted: string[],
  ) {}

  static async start(config: Config, opts: { trusted: boolean; log?: Log; warn?: (text: string) => void }): Promise<McpManager> {
    const { specs, untrusted, warnings } = serversFor(config, opts.trusted);
    for (const w of warnings) opts.warn?.(w);
    if (untrusted.length) opts.warn?.(`Not starting the MCP servers in .mcp.json (${untrusted.join(", ")}): this folder isn't trusted. Open ngobe here interactively and trust it to use them.`);
    const lean = config.toolProfile !== "full";
    const results = await Promise.all(specs.map((s) => connectServer(s, { log: opts.log, lean })));
    const tools: Tool[] = [];
    const names = new Set<string>();
    for (const r of results) {
      if (r.status.state === "failed") opts.warn?.(`MCP server ${r.status.name} failed: ${r.status.error}`);
      for (const line of r.status.rejected ?? []) opts.warn?.(`MCP server ${r.status.name}: left out ${line}`);
      if (!r.client) continue;
      for (const def of r.defs) {
        const tool = toTool(r.client, def, lean);
        if (names.has(tool.name)) continue; // two names that sanitize alike: the first one stays
        names.add(tool.name);
        tools.push(tool);
      }
    }
    return new McpManager(
      results.map((r) => r.status),
      tools,
      results.flatMap((r) => (r.client ? [r.client] : [])),
      untrusted,
    );
  }

  /** Servers whose tool list changed since the start (seen at the next session). */
  get changed(): string[] {
    return this.clients.filter((c) => c.toolsChanged).map((c) => c.spec.name);
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close()));
  }
}

/** One line per server, for /mcp, `ngobe mcp list` and doctor. */
export function statusLine(s: McpServerStatus): string {
  if (s.state === "disabled") return `${s.name}: disabled (${s.scope})`;
  if (s.state === "failed") return `${s.name}: failed: ${s.error}`;
  const via = s.transport === "stdio" ? "stdio" : s.transport === "sse" ? "HTTP+SSE" : "HTTP";
  const cost = s.promptTokens ? `, ~${s.promptTokens} prompt tokens` : "";
  return `${s.name}: ${s.tools.length} tool${s.tools.length === 1 ? "" : "s"}${cost} (${via}, MCP ${s.version}${s.server ? `, ${s.server}` : ""}${s.ms !== undefined ? `, ${s.ms} ms` : ""})`;
}
