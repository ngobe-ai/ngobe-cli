import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import net from "node:net";
import { parseArgs } from "node:util";

export type Mode = "ask" | "plan" | "edit" | "auto";
export const MODES: readonly Mode[] = ["ask", "plan", "edit", "auto"];
export type ToolMode = "auto" | "native" | "text";
export type ToolProfile = "lean" | "full";
export type SearchProvider = "brave" | "tavily" | "searxng";
export const SEARCH_PROVIDERS: readonly SearchProvider[] = ["brave", "tavily", "searxng"];

export interface Config {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Tried once when the main model is missing or unreachable. "" = none. */
  fallbackModel: string;
  /** Reach the model server over SSH: "user@host" or "user@host:port" ("" = no tunnel). */
  sshTunnel: string;
  /** host:port of the model server as seen from the SSH host (default 127.0.0.1:<baseURL port>). */
  sshTunnelTarget: string;
  /** native = OpenAI tool calling; text = <tool_call> protocol in the prompt; auto = native, switching to text if refused. */
  toolMode: ToolMode;
  /** lean: 12 core tools with one-line descriptions (small/CPU models); full: everything (large models). */
  toolProfile: ToolProfile;
  mode: Mode;
  maxTurns: number;
  maxToolCalls: number;
  maxRunSeconds: number;
  maxContextChars: number;
  /** Seconds without a streamed chunk before a model request is abandoned (CPU inference can be slow to start). */
  requestTimeout: number;
  /** Sampling temperature; undefined = the server's default. Low keeps small models' tool calls steady. */
  temperature?: number;
  maxRetries: number;
  cwd: string;
  /** Memory database, logs and prompt variants. */
  stateDir: string;
  /** HTTP response cache. */
  cacheDir: string;
  memory: boolean;
  /** A vision model on the same server that describes images for the coding model ("" = none). */
  visionModel: string;
  /** The chat takes the mouse wheel to scroll the conversation (NGOBE_MOUSE=0: the terminal keeps it). */
  mouse: boolean;
  /** NGOBE.md: the global memory, next to config.json unless NGOBE_MEMORY_FILE says otherwise. */
  memoryFile: string;
  /** Interactive sessions: have the server process the fixed prompt prefix before the first request. */
  warmup: boolean;
  /** Keep the model loaded and the conversation cached while the user was active this many minutes ago (0 = off). */
  keepWarmMinutes: number;
  /** Tried in order; the next one is used only when one fails or finds nothing. */
  searchProviders: SearchProvider[];
  braveApiKey: string;
  tavilyApiKey: string;
  searxngURL: string;
  /** Sent as a bearer token to a SearXNG behind an authenticating gateway. Environment only. */
  searxngKey: string;
  githubToken: string;
  /** Extra official documentation domains per technology, merged over the built-in list. */
  docs: Record<string, string[]>;
  debug: boolean;
}

export class ConfigError extends Error {}

export const COMMANDS = [
  "ask",
  "plan",
  "code",
  "fix",
  "review",
  "test",
  "search",
  "docs",
  "version",
  "memory",
  "learn",
  "benchmark",
  "doctor",
  "config",
  "update",
  "upgrade",
] as const;
export type Command = (typeof COMMANDS)[number];

// Standalone binaries have no package.json beside them: the build script defines this.
declare const NGOBE_BUILD_VERSION: string | undefined;
export const VERSION: string =
  typeof NGOBE_BUILD_VERSION === "string" ? NGOBE_BUILD_VERSION : createRequire(import.meta.url)("../package.json").version;
/** True in the standalone binaries built by scripts/build-binaries.ts (not the npm package). */
export const STANDALONE = typeof NGOBE_BUILD_VERSION === "string";

export const HELP = `Usage: ngobe [command] [options] [prompt]

Without a command, a prompt runs the agent once (edit mode); no prompt starts the chat REPL.

Agent commands (one-shot):
  ask <question>         answer using read-only tools and live sources; never edits files
  plan <task>            inspect the project and propose changes without editing
  code <task>            implement a change (same as a bare prompt)
  fix <problem>          reproduce, fix minimally, and run the relevant tests
  review [git ref]       review uncommitted changes (or changes since a ref)

Direct commands (no model needed):
  test                   detect and run the project's test command
  search <query>         web search through the configured provider
  docs <tech> <query>    search official documentation for a technology
  version <name> [--ecosystem npm|pypi|pub|packagist|github|...]
                         latest stable release from the official source, plus the installed version
  memory [list|show <id>|export|delete <id>|clear|disable|enable]
  learn [promote <variant>|rollback|variants]
                         run outcomes, recurring failures, tool reliability, prompt variants
  benchmark [--variant <name>] [--task <id>]
                         run the evaluation set against the configured model
  doctor                 check model endpoint, tools, search, memory and system resources
  config                 show the effective configuration (secrets redacted)
  upgrade                update ngobe to the latest release (Homebrew, npm or the standalone binary; also: update)

Options:
  -m, --model <name>     model name
      --base-url <url>   OpenAI-compatible endpoint
      --mode <mode>      ask | plan | edit | auto (default edit)
      --yolo             deprecated alias for --mode auto (dangerous commands still ask)
      --ecosystem <eco>  for "version"
      --json             machine-readable output for direct commands
  -y, --yes              skip the confirmation for "memory clear"
      --debug            log tool selection and timings to stderr
  -v, --version          print the ngobe version
  -h, --help             show this help

Environment (NGOBE_* first, MUGAMBA_* still read as a fallback):
  NGOBE_BASE_URL, NGOBE_API_KEY, NGOBE_MODEL, NGOBE_FALLBACK_MODEL, NGOBE_TOOL_MODE,
  NGOBE_TOOL_PROFILE (lean | full),
  NGOBE_SSH_TUNNEL (user@host:port), NGOBE_SSH_TUNNEL_TARGET (default 127.0.0.1:<baseURL port>),
  NGOBE_MODE, NGOBE_MAX_TURNS, NGOBE_MAX_TOOL_CALLS, NGOBE_MAX_RUN_SECONDS,
  NGOBE_MAX_CONTEXT_CHARS, NGOBE_REQUEST_TIMEOUT, NGOBE_MAX_RETRIES, NGOBE_STATE_DIR,
  NGOBE_VISION_MODEL (describes images), NGOBE_CACHE_DIR, NGOBE_MEMORY, NGOBE_MEMORY_FILE (NGOBE.md), NGOBE_SEARCH_PROVIDERS (e.g. "brave,searxng"),
  BRAVE_API_KEY, TAVILY_API_KEY, NGOBE_SEARXNG_URL, NGOBE_SEARXNG_KEY, GITHUB_TOKEN, NGOBE_DEBUG
Config file: $XDG_CONFIG_HOME/ngobe/config.json (default ~/.config/ngobe/config.json).
Secrets (API keys, tokens) are read from the environment only.`;

type Env = Record<string, string | undefined>;

/** NGOBE_<name>, falling back to the old MUGAMBA_<name>. */
function envVar(env: Env, name: string): string | undefined {
  const v = env[`NGOBE_${name}`] ?? env[`MUGAMBA_${name}`];
  return v === "" ? undefined : v;
}

/** A raw setting and where it came from, so errors name the variable the user actually set. */
interface Setting {
  raw: unknown;
  label: string;
}

/** 0 to 2; "default" leaves it to the server. */
function temperature(s: Setting): number | undefined {
  if (s.raw === undefined || s.raw === null || s.raw === "") return 0.2;
  if (s.raw === "default") return undefined;
  const n = Number(s.raw);
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new ConfigError(`${s.label} must be a number from 0 to 2, or "default" (got "${s.raw}")`);
  return n;
}

function int(s: Setting, fallback: number, min = 1): number {
  if (s.raw === undefined || s.raw === null || s.raw === "") return fallback;
  const n = Number(s.raw);
  if (!Number.isInteger(n) || n < min) {
    throw new ConfigError(`${s.label} must be ${min === 1 ? "a positive integer" : `an integer >= ${min}`} (got "${s.raw}")`);
  }
  return n;
}

/** NGOBE_SEARCH_PROVIDERS ("brave,searxng"), or every provider whose key or URL is set. */
function searchProviders(s: Setting, available: Record<SearchProvider, boolean>): SearchProvider[] {
  if (s.raw === undefined || s.raw === null || s.raw === "") return SEARCH_PROVIDERS.filter((p) => available[p]);
  const list = (Array.isArray(s.raw) ? s.raw : String(s.raw).split(",")).map((p) => String(p).trim()).filter(Boolean);
  for (const p of list) oneOf({ raw: p, label: s.label }, SEARCH_PROVIDERS, "brave");
  return list as SearchProvider[];
}

function oneOf<T extends string>(s: Setting, allowed: readonly T[], fallback: T): T {
  if (s.raw === undefined || s.raw === null || s.raw === "") return fallback;
  if (!allowed.includes(s.raw as T)) throw new ConfigError(`${s.label} must be one of ${allowed.join(", ")} (got "${s.raw}")`);
  return s.raw as T;
}

function bool(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  return !["0", "false", "no", "off"].includes(String(raw).toLowerCase());
}

export function configFilePath(env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "ngobe", "config.json");
}

const SECRET_KEYS = ["apiKey", "braveApiKey", "tavilyApiKey", "searxngKey", "githubToken"];

/** The user-level config file. A project directory can't supply one: a cloned repo must not redirect the model endpoint. */
function readConfigFile(file: string): { values: Record<string, unknown>; warnings: string[] } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { values: {}, warnings: [] };
  }
  let values: Record<string, unknown>;
  try {
    values = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  const warnings: string[] = [];
  for (const key of SECRET_KEYS) {
    if (key in values) {
      warnings.push(`${file}: "${key}" is ignored; put secrets in the environment instead`);
      delete values[key];
    }
  }
  return { values, warnings };
}

export interface LoadedConfig {
  config: Config;
  command: Command | null;
  /** Positional arguments after the command (or the whole prompt when there is no command). */
  args: string[];
  prompt: string;
  json: boolean;
  /** --yes: confirm destructive direct commands (memory clear) without a prompt. */
  yes: boolean;
  ecosystem: string;
  variant: string;
  task: string;
  warnings: string[];
}

export function loadConfig(argv: string[] = process.argv.slice(2), env: Env = process.env): LoadedConfig {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      model: { type: "string", short: "m" },
      "base-url": { type: "string" },
      mode: { type: "string" },
      yolo: { type: "boolean" },
      ecosystem: { type: "string" },
      variant: { type: "string" },
      task: { type: "string" },
      json: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      debug: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }
  if (values.version) {
    console.log(VERSION);
    process.exit(0);
  }

  const { values: file, warnings } = readConfigFile(configFilePath(env));
  /** A setting from a flag, then NGOBE_/MUGAMBA_ environment, then the config file. */
  const setting = (envName: string, key: string, flag?: unknown): Setting => {
    if (flag !== undefined) return { raw: flag, label: `--${key}` };
    for (const prefix of ["NGOBE_", "MUGAMBA_"]) {
      const v = env[prefix + envName];
      if (v !== undefined && v !== "") return { raw: v, label: prefix + envName };
    }
    if (file[key] !== undefined) return { raw: file[key], label: `"${key}" in ${configFilePath(env)}` };
    return { raw: undefined, label: `NGOBE_${envName}` };
  };

  const home = os.homedir();
  const stateDir =
    envVar(env, "STATE_DIR") ?? (file.stateDir as string) ?? path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), "ngobe");
  const cacheDir =
    envVar(env, "CACHE_DIR") ?? (file.cacheDir as string) ?? path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "ngobe");

  const braveApiKey = envVar(env, "BRAVE_API_KEY") ?? env.BRAVE_API_KEY ?? "";
  const tavilyApiKey = envVar(env, "TAVILY_API_KEY") ?? env.TAVILY_API_KEY ?? "";
  const searxngURL = String(envVar(env, "SEARXNG_URL") ?? file.searxngURL ?? "");
  const searxngKey = envVar(env, "SEARXNG_KEY") ?? "";

  const config: Config = {
    baseURL: String(setting("BASE_URL", "baseURL", values["base-url"]).raw ?? "http://localhost:11434/v1"),
    apiKey: envVar(env, "API_KEY") ?? "not-needed",
    model: String(setting("MODEL", "model", values.model).raw ?? "qwen3-coder"),
    fallbackModel: String(setting("FALLBACK_MODEL", "fallbackModel").raw ?? ""),
    sshTunnel: String(setting("SSH_TUNNEL", "sshTunnel").raw ?? ""),
    sshTunnelTarget: String(setting("SSH_TUNNEL_TARGET", "sshTunnelTarget").raw ?? ""),
    toolMode: oneOf<ToolMode>(setting("TOOL_MODE", "toolMode"), ["auto", "native", "text"], "auto"),
    toolProfile: oneOf<ToolProfile>(setting("TOOL_PROFILE", "toolProfile"), ["lean", "full"], "lean"),
    mode: oneOf<Mode>(setting("MODE", "mode", values.yolo ? "auto" : values.mode), MODES, "edit"),
    maxTurns: int(setting("MAX_TURNS", "maxTurns"), 40),
    maxToolCalls: int(setting("MAX_TOOL_CALLS", "maxToolCalls"), 100),
    maxRunSeconds: int(setting("MAX_RUN_SECONDS", "maxRunSeconds"), 1800),
    maxContextChars: int(setting("MAX_CONTEXT_CHARS", "maxContextChars"), 200_000),
    requestTimeout: int(setting("REQUEST_TIMEOUT", "requestTimeout"), 300),
    temperature: temperature(setting("TEMPERATURE", "temperature")),
    maxRetries: int(setting("MAX_RETRIES", "maxRetries"), 2, 0),
    cwd: process.cwd(),
    stateDir,
    cacheDir,
    memory: bool(setting("MEMORY", "memory").raw, true),
    mouse: bool(setting("MOUSE", "mouse").raw, true),
    visionModel: String(setting("VISION_MODEL", "visionModel").raw ?? ""),
    memoryFile: envVar(env, "MEMORY_FILE") ?? path.join(path.dirname(configFilePath(env)), "NGOBE.md"),
    warmup: bool(setting("WARMUP", "warmup").raw, true),
    keepWarmMinutes: int(setting("KEEP_WARM_MINUTES", "keepWarmMinutes"), 30, 0),
    searchProviders: searchProviders(setting("SEARCH_PROVIDERS", "searchProviders"), {
      brave: !!braveApiKey,
      tavily: !!tavilyApiKey,
      searxng: !!searxngURL,
    }),
    braveApiKey,
    tavilyApiKey,
    searxngURL,
    searxngKey,
    githubToken: env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "",
    docs: (file.docs as Record<string, string[]>) ?? {},
    debug: bool(values.debug ?? envVar(env, "DEBUG") ?? file.debug, false),
  };
  if (values.yolo) warnings.push("--yolo is deprecated: it now means --mode auto, and dangerous commands still ask");

  const first = positionals[0];
  const command = (COMMANDS as readonly string[]).includes(first) ? (first as Command) : null;
  const args = command ? positionals.slice(1) : positionals;
  return {
    config,
    command,
    args,
    prompt: args.join(" ").trim(),
    json: values.json ?? false,
    yes: values.yes ?? false,
    ecosystem: values.ecosystem ?? "",
    variant: values.variant ?? "",
    task: values.task ?? "",
    warnings,
  };
}

/** Set one key in the user config file (/model saves the choice there), keeping everything else. */
export function saveSetting(key: string, value: unknown, env: Env = process.env): string {
  const file = configFilePath(env);
  let values: Record<string, unknown> = {};
  try {
    values = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new ConfigError(`${file} could not be read: ${err instanceof Error ? err.message : err}`);
  }
  values[key] = value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(values, null, 2) + "\n");
  return file;
}

/** Config for display: secrets replaced. */
export function redactedConfig(config: Config): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const key of SECRET_KEYS) {
    const v = out[key];
    if (typeof v === "string" && v && v !== "not-needed") out[key] = `${v.slice(0, 3)}…(${v.length} chars)`;
  }
  return out;
}

/** True when the endpoint is on this machine or a private network (code stays local). */
export function isLocalEndpoint(baseURL: string): boolean {
  let host: string;
  try {
    host = new URL(baseURL).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  const ip = host.replace(/^\[|\]$/g, "");
  if (net.isIPv6(ip)) return ip === "::1" || /^f[cd]/i.test(ip);
  // Only real IPv4 addresses: "10.evil.com" is a public name.
  return net.isIPv4(ip) && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}
