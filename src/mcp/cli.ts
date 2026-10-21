import fs from "node:fs";
import path from "node:path";
import { configFilePath, type LoadedConfig } from "../config.js";
import { isTrusted } from "../trust.js";
import { bold, dim, green, red, yellow } from "../ui.js";
import { PROJECT_FILE, readServersFile, redactServer, toSpec, type McpServerConfig } from "./config.js";
import { connectServer, serversFor, statusLine, targetOf } from "./index.js";

const USAGE = `Usage:
  ngobe mcp list                       servers here, with a connection check
  ngobe mcp get <name>                 one server's settings and tools
  ngobe mcp add [-s user|project] [-t stdio|http|sse] [-e KEY=value]… [-H "Name: value"]… <name> -- <command> [args…]
  ngobe mcp add -t http <name> <url>
  ngobe mcp remove [-s user|project] <name>`;

/** ngobe mcp …: manage MCP servers without a model. Returns the exit code. */
export async function cmdMcp(loaded: LoadedConfig): Promise<number> {
  const [sub = "list", ...rest] = loaded.args;
  switch (sub) {
    case "list":
      return list(loaded);
    case "get":
      return get(loaded, rest[0]);
    case "add":
      return add(loaded, rest);
    case "remove":
    case "rm":
      return remove(loaded, rest[0]);
    default:
      console.error(USAGE);
      return 2;
  }
}

async function list(loaded: LoadedConfig): Promise<number> {
  const { config } = loaded;
  if (!config.mcp) console.log(yellow("MCP is off (NGOBE_MCP=0): sessions start none of these."));
  const trusted = isTrusted(config.cwd, config.stateDir);
  const { specs, untrusted, warnings } = serversFor(config, trusted);
  for (const w of warnings) console.log(yellow(w));
  if (!specs.length && !untrusted.length) {
    console.log(`No MCP servers. Add one with: ngobe mcp add <name> -- <command> [args…]  (see ngobe --help)`);
    return 0;
  }
  if (!loaded.json) console.log(dim("Checking MCP server health…"));
  const results = await Promise.all(specs.map((s) => connectServer(s, { lean: config.toolProfile !== "full" })));
  await Promise.all(results.map((r) => r.client?.close()));
  if (loaded.json) {
    console.log(JSON.stringify({ servers: results.map((r) => r.status), untrusted }, null, 2));
    return 0;
  }
  for (const { status } of results) {
    const mark = status.state === "connected" ? green("✓") : status.state === "failed" ? red("✗") : dim("-");
    console.log(`${mark} ${statusLine(status)}\n    ${dim(`${status.scope}: ${status.target}`)}`);
  }
  if (untrusted.length) console.log(`${yellow("!")} ${PROJECT_FILE} here has ${untrusted.join(", ")}, not used: this folder isn't trusted (open ngobe here interactively and trust it).`);
  return results.some((r) => r.status.state === "failed") ? 1 : 0;
}

async function get(loaded: LoadedConfig, name: string | undefined): Promise<number> {
  if (!name) {
    console.error(USAGE);
    return 2;
  }
  const { config } = loaded;
  const { specs, untrusted } = serversFor(config, isTrusted(config.cwd, config.stateDir));
  const spec = specs.find((s) => s.name === name);
  if (!spec) {
    console.error(untrusted.includes(name) ? `${name} is in ${PROJECT_FILE}, but this folder isn't trusted.` : `No MCP server named ${name}.`);
    return 1;
  }
  const raw = spec.scope === "user" ? config.mcpServers[name] : readServersFile(spec.source)?.[name];
  console.log(`${bold(name)} ${dim(`(${spec.scope}: ${spec.source})`)}`);
  console.log(JSON.stringify(redactServer(raw), null, 2));
  const { client, status, defs } = await connectServer(spec, { lean: config.toolProfile !== "full" });
  await client?.close();
  console.log(`${status.state === "connected" ? green("✓") : red("✗")} ${statusLine(status)}`);
  for (const d of defs) {
    const a = d.annotations ?? {};
    const tags = [a.readOnlyHint ? "read-only" : "", a.destructiveHint ? "destructive" : "", spec.autoApprove.has(d.name) ? "auto-approved" : ""].filter(Boolean);
    console.log(`  • mcp__${name}__${d.name}${tags.length ? dim(` [${tags.join(", ")}]`) : ""}: ${(d.description ?? "").split("\n")[0].slice(0, 120)}`);
  }
  return status.state === "connected" ? 0 : 1;
}

function scopeOf(loaded: LoadedConfig): "user" | "project" | null {
  const s = loaded.scope || "user";
  if (s === "user" || s === "project") return s;
  console.error(`--scope must be user or project (got "${s}")`);
  return null;
}

/** Read a JSON settings file (missing = empty), refusing to overwrite one that doesn't parse. */
function readJson(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${file} is not a JSON object`);
  return v as Record<string, unknown>;
}

function writeServers(file: string, edit: (servers: Record<string, unknown>) => void): void {
  const values = readJson(file);
  const servers = values.mcpServers && typeof values.mcpServers === "object" && !Array.isArray(values.mcpServers) ? { ...(values.mcpServers as Record<string, unknown>) } : {};
  edit(servers);
  values.mcpServers = servers;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(values, null, 2)}\n`);
}

async function add(loaded: LoadedConfig, rest: string[]): Promise<number> {
  const scope = scopeOf(loaded);
  if (!scope) return 2;
  const [name, target, ...args] = rest;
  if (!name || !target) {
    console.error(USAGE);
    return 2;
  }
  const transport = loaded.transport || (/^https?:\/\//i.test(target) ? "http" : "stdio");
  const entry: McpServerConfig = {};
  if (transport === "stdio") {
    Object.assign(entry, { command: target, ...(args.length ? { args } : {}) });
    if (loaded.env.length) {
      const env: Record<string, string> = {};
      for (const kv of loaded.env) {
        const eq = kv.indexOf("=");
        if (eq <= 0) {
          console.error(`--env takes KEY=value (got "${kv}")`);
          return 2;
        }
        env[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      entry.env = env;
    }
  } else if (transport === "http" || transport === "sse") {
    Object.assign(entry, { type: transport, url: target });
    if (loaded.headers.length) {
      const headers: Record<string, string> = {};
      for (const h of loaded.headers) {
        const colon = h.indexOf(":");
        if (colon <= 0) {
          console.error(`--header takes "Name: value" (got "${h}")`);
          return 2;
        }
        headers[h.slice(0, colon).trim()] = h.slice(colon + 1).trim();
      }
      entry.headers = headers;
    }
  } else {
    console.error(`--transport must be stdio, http or sse (got "${transport}")`);
    return 2;
  }
  // Same checks as at startup, so a typo shows now rather than at the next session.
  const check = toSpec(name, entry, scope, "", { cwd: loaded.config.cwd, connectTimeoutMs: 1, toolTimeoutMs: 1, env: process.env });
  if (check.error && !check.error.startsWith("environment variable")) {
    console.error(`Not added: ${check.error}`);
    return 2;
  }
  const file = scope === "user" ? configFilePath() : path.join(loaded.config.cwd, PROJECT_FILE);
  let replaced = false;
  writeServers(file, (servers) => {
    replaced = name in servers;
    servers[name] = entry;
  });
  console.log(`${replaced ? "Replaced" : "Added"} MCP server ${bold(name)} (${transport}: ${targetOf(check)}) in ${file}`);
  if (check.error) console.log(yellow(`Note: ${check.error}; set it before starting ngobe.`));
  if (scope === "project") console.log(dim(`${PROJECT_FILE} is used only in folders you trust; commit it to share the server with the project.`));
  console.log(dim("New sessions use it; check it with: ngobe mcp get " + name));
  return 0;
}

async function remove(loaded: LoadedConfig, name: string | undefined): Promise<number> {
  if (!name) {
    console.error(USAGE);
    return 2;
  }
  const scopes: ("user" | "project")[] = loaded.scope ? [scopeOf(loaded) ?? "user"] : ["user", "project"];
  for (const scope of scopes) {
    const file = scope === "user" ? configFilePath() : path.join(loaded.config.cwd, PROJECT_FILE);
    if (!fs.existsSync(file) || !(name in ((readJson(file).mcpServers as Record<string, unknown>) ?? {}))) continue;
    writeServers(file, (servers) => {
      delete servers[name];
    });
    console.log(`Removed MCP server ${bold(name)} from ${file}`);
    return 0;
  }
  console.error(`No MCP server named ${name}${loaded.scope ? ` in the ${loaded.scope} scope` : ""}.`);
  return 1;
}
