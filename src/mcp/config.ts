import fs from "node:fs";
import path from "node:path";

/**
 * MCP server settings, in the format Claude Code uses (so a project's .mcp.json works in both):
 * "mcpServers" in the user's config.json, and .mcp.json at the project root.
 *
 *   { "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *                     "docs": { "type": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } } } }
 *
 * ${VAR} and ${VAR:-default} are expanded from ngobe's environment in command, args, env, cwd,
 * url and headers. Ngobe's additions: autoApprove (tool names that run without asking), tools
 * (only offer these: every tool definition costs prompt tokens), toolTimeout, disabled.
 */

export interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Startup limit: seconds (or milliseconds when over 1000, as Claude Code's MCP_TIMEOUT). */
  timeout?: number;
  /** Limit for one tool call, same units. */
  toolTimeout?: number;
  autoApprove?: string[];
  tools?: string[];
  disabled?: boolean;
}

export type McpScope = "user" | "project";
export type McpTransport = "stdio" | "http" | "sse";

/** A server ready to connect to: expanded, validated, with its limits worked out. */
export interface McpServerSpec {
  name: string;
  scope: McpScope;
  /** The file it came from. */
  source: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  url: string;
  headers: Record<string, string>;
  connectTimeoutMs: number;
  toolTimeoutMs: number;
  autoApprove: Set<string>;
  /** Only these tools are offered (null = all). */
  allow: Set<string> | null;
  disabled: boolean;
  /** Set when the entry can't be used (bad shape, unset variable): shown instead of connecting. */
  error?: string;
}

export const PROJECT_FILE = ".mcp.json";
const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** "${TOKEN}" → its value; an unset variable without a default is reported, not replaced with "". */
export function expandVars(text: string, env: Record<string, string | undefined>, missing: Set<string>): string {
  return text.replace(VAR, (_m, name: string, fallback: string | undefined) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return "";
  });
}

/** Seconds, or milliseconds when the number is over 1000 (Claude Code's MCP_TIMEOUT is in ms). */
export function toMs(value: unknown, fallbackMs: number): number {
  const n = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(n) || n <= 0) return fallbackMs;
  return n > 1000 ? Math.round(n) : Math.round(n * 1000);
}

function transportOf(raw: McpServerConfig): McpTransport | null {
  const t = String(raw.type ?? "").toLowerCase().replace(/[-_]/g, "");
  if (!t) return raw.url ? "http" : "stdio";
  if (t === "stdio") return "stdio";
  if (t === "http" || t === "streamablehttp") return "http";
  if (t === "sse") return "sse";
  return null;
}

const stringMap = (v: unknown): Record<string, string> =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])) : {};
const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

export interface SpecDefaults {
  cwd: string;
  connectTimeoutMs: number;
  toolTimeoutMs: number;
  env: Record<string, string | undefined>;
}

/** One entry of "mcpServers", expanded and checked. */
export function toSpec(name: string, raw: unknown, scope: McpScope, source: string, d: SpecDefaults): McpServerSpec {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as McpServerConfig;
  const missing = new Set<string>();
  const x = (s: string) => expandVars(s, d.env, missing);
  const transport = transportOf(r);
  const cwd = r.cwd ? path.resolve(d.cwd, x(String(r.cwd))) : d.cwd;
  const spec: McpServerSpec = {
    name,
    scope,
    source,
    transport: transport ?? "stdio",
    command: r.command ? x(String(r.command)) : "",
    args: stringList(r.args).map(x),
    env: Object.fromEntries(Object.entries(stringMap(r.env)).map(([k, v]) => [k, x(v)])),
    cwd,
    url: r.url ? x(String(r.url)) : "",
    headers: Object.fromEntries(Object.entries(stringMap(r.headers)).map(([k, v]) => [k, x(v)])),
    connectTimeoutMs: toMs(r.timeout, d.connectTimeoutMs),
    toolTimeoutMs: toMs(r.toolTimeout, d.toolTimeoutMs),
    autoApprove: new Set(stringList(r.autoApprove)),
    allow: Array.isArray(r.tools) ? new Set(stringList(r.tools)) : null,
    disabled: r.disabled === true,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) spec.error = "must be an object";
  else if (!NAME.test(name)) spec.error = "server names may only use letters, digits, - and _ (40 at most)";
  else if (!transport) spec.error = `unknown type "${r.type}" (use stdio, http or sse)`;
  else if (transport === "stdio" && !spec.command) spec.error = 'needs a "command"';
  else if (transport !== "stdio" && !/^https?:\/\//i.test(spec.url)) spec.error = 'needs an http(s) "url"';
  else if (missing.size) spec.error = `environment variable${missing.size > 1 ? "s" : ""} ${[...missing].join(", ")} not set`;
  return spec;
}

/** The "mcpServers" object of a JSON file, or null when the file isn't there. */
export function readServersFile(file: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const parsed = JSON.parse(text) as { mcpServers?: unknown };
  const servers = parsed?.mcpServers;
  return servers && typeof servers === "object" && !Array.isArray(servers) ? (servers as Record<string, unknown>) : {};
}

export interface LoadedServers {
  specs: McpServerSpec[];
  /** Names in an untrusted folder's .mcp.json, not loaded. */
  untrusted: string[];
  warnings: string[];
}

/**
 * The servers to use here: the user's, then the project's .mcp.json (same name: the project's
 * wins, as in Claude Code). A project file can start any program, so it is read only in a folder
 * the user trusts.
 */
export function loadServers(opts: { user: Record<string, unknown>; userFile: string; cwd: string; trusted: boolean; defaults: Omit<SpecDefaults, "cwd"> }): LoadedServers {
  const defaults = { ...opts.defaults, cwd: opts.cwd };
  const byName = new Map<string, McpServerSpec>();
  for (const [name, raw] of Object.entries(opts.user)) byName.set(name, toSpec(name, raw, "user", opts.userFile, defaults));
  const warnings: string[] = [];
  let untrusted: string[] = [];
  const file = path.join(opts.cwd, PROJECT_FILE);
  let project: Record<string, unknown> | null = null;
  try {
    project = readServersFile(file);
  } catch (err) {
    warnings.push(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (project && !opts.trusted) untrusted = Object.keys(project);
  else if (project) for (const [name, raw] of Object.entries(project)) byName.set(name, toSpec(name, raw, "project", file, defaults));
  const specs = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { specs, untrusted, warnings };
}

// Header names whose values are credentials.
const SECRET_HEADER = /authorization|cookie|token|key|secret|session/i;

/** A server entry for display: env values hidden, credential headers redacted. */
export function redactServer(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const r = { ...(raw as Record<string, unknown>) };
  if (r.env && typeof r.env === "object") r.env = Object.fromEntries(Object.keys(r.env).map((k) => [k, "[hidden]"]));
  if (r.headers && typeof r.headers === "object") {
    r.headers = Object.fromEntries(
      Object.entries(r.headers as Record<string, unknown>).map(([k, v]) => [k, SECRET_HEADER.test(k) && !/^\$\{[^}]+\}$/.test(String(v)) ? "[redacted]" : v]),
    );
  }
  if (typeof r.url === "string") r.url = r.url.replace(/([?&](?:key|token|api[_-]?key|access_token)=)[^&]+/gi, "$1[redacted]");
  return r;
}

export function redactServers(servers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(servers).map(([k, v]) => [k, redactServer(v)]));
}
