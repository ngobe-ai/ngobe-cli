import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFilePath, isLocalEndpoint, VERSION, type Config, type LoadedConfig } from "./config.js";
import { LLM, type ModelInfo } from "./llm.js";
import { Memory } from "./memory/store.js";
import { latestVersion } from "./releases/versions.js";
import { buildTools } from "./tools/index.js";
import { isTrusted } from "./trust.js";
import { bold, dim, green, red, yellow } from "./ui.js";
import { httpJson } from "./web/http.js";
import { updateNotice } from "./update.js";
import { webSearch } from "./web/search.js";
import { visionModels } from "./vision.js";

const ok = (s: string) => `${green("✓")} ${s}`;
const bad = (s: string) => `${red("✗")} ${s}`;
const warn = (s: string) => `${yellow("!")} ${s}`;
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t = Date.now();
  const v = await fn();
  return [v, Date.now() - t];
};

/** Diagnostics for the model endpoint, tools, search, sources, memory and machine. Exit 1 if the model is unusable. */
export async function cmdDoctor(loaded: LoadedConfig): Promise<number> {
  const { config } = loaded;
  let healthy = true;
  const runtime = typeof (globalThis as { Bun?: { version: string } }).Bun !== "undefined" ? `bun ${(globalThis as unknown as { Bun: { version: string } }).Bun.version}` : `node ${process.version}`;
  const mem = availableMemory();
  console.log(bold(`ngobe ${VERSION}`) + dim(` (${runtime}, ${os.platform()} ${os.arch()}, ${os.cpus().length} CPUs, ${gib(mem)} available of ${gib(os.totalmem())} RAM)`));
  try {
    const notice = await updateNotice(loaded);
    if (notice) console.log(`        ${warn(notice)}`);
  } catch (err) {
    console.log(dim(`        could not check for updates: ${message(err)}`));
  }

  const file = configFilePath();
  console.log(`${bold("config ")} ${fs.existsSync(file) ? file : dim(`${file} (none; environment and defaults)`)}; mode ${config.mode}, tool calling ${config.toolMode}`);
  for (const w of loaded.warnings) console.log(`        ${warn(w)}`);

  // --- model -----------------------------------------------------------------------
  const llm = new LLM(config);
  if (config.sshTunnel) {
    try {
      console.log(`${bold("tunnel ")} ${ok((await llm.ready()) ?? "")}`);
    } catch (err) {
      console.log(`${bold("tunnel ")} ${bad(message(err))}`);
      return 1;
    }
  }
  const where = config.sshTunnel
    ? `your server, through SSH to ${config.sshTunnel}`
    : isLocalEndpoint(config.baseURL)
      ? "local"
      : yellow("remote: prompts and code are sent to this host");
  let models: ModelInfo[] = [];
  try {
    const [list, ms] = await timed(() => llm.models());
    models = list;
    console.log(`${bold("model  ")} ${ok(`${config.baseURL} reachable (${ms} ms, ${where})`)}`);
    const ids = models.map((m) => m.id);
    if (ids.length) console.log(dim(`         serves: ${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ` (+${ids.length - 8})` : ""}`));
    for (const vision of visionModels(config)) {
      const served = ids.some((id) => id === vision || id.endsWith(`/${vision}`));
      console.log(`${bold("vision ")} ${served ? ok(`${vision} describes images for the model`) : warn(`${vision} is not on this server; images get OCR at most`)}`);
    }
  } catch (err) {
    healthy = false;
    // A 401/403 means the server answered: it's the key, not the network.
    const refused = /^40[13]\b/.test(message(err));
    console.log(`${bold("model  ")} ${bad(`${config.baseURL} ${refused ? "refused the request" : "unreachable"}: ${message(err)}`)}`);
    const hint = await suggestEndpoint(config);
    if (hint) console.log(`         ${warn(hint)}`);
  }
  if (healthy) {
    const listed = models.some((m) => m.id === config.model || m.id.endsWith(`/${config.model}`));
    if (models.length && !listed) console.log(`         ${warn(`${config.model} is not in the served list (it may still load on demand)`)}`);
    try {
      const probe = await llm.probe();
      const tools = { native: "native tool calls", text: "writes tool calls as text (parsed automatically)", none: "did not call the test tool (tool use may be unreliable)", unsupported: "endpoint refuses tools (text protocol will be used)" }[probe.toolCalls];
      console.log(`         ${(probe.toolCalls === "none" ? warn : ok)(`${config.model} answered in ${(probe.ms / 1000).toFixed(1)}s; ${tools}`)}`);
    } catch (err) {
      healthy = false;
      console.log(`         ${bad(`${config.model} failed: ${message(err)}`)}`);
    }
    // Memory fit only means something when the model runs on this machine.
    if (!config.sshTunnel && isLocalEndpoint(config.baseURL)) {
      for (const line of await modelResources(config, models, mem)) console.log(`         ${line}`);
    } else {
      const m = models.find((x) => x.id === config.model)?.raw.dmr as { size?: string; parameters?: string; context_window?: number } | undefined;
      if (m) console.log(dim(`         ${[m.parameters && `${m.parameters} params`, m.size, m.context_window && `${m.context_window}-token context`].filter(Boolean).join(", ")} (runs on the server)`));
    }
  }
  if (config.fallbackModel) console.log(dim(`         fallback model: ${config.fallbackModel}`));

  // --- tools -------------------------------------------------------------------------
  const bins = await Promise.all(["git", "rg", "bash"].map(async (b) => [b, await which(b)] as const));
  const tools = buildTools(config, { memory: config.memory });
  console.log(`${bold("tools  ")} ${tools.length} available; ${bins.map(([b, found]) => (found ? ok(b) : b === "rg" ? warn("rg (grep falls back to a slower JS search)") : bad(b))).join("  ")}`);

  // --- MCP servers -------------------------------------------------------------------
  if (!config.mcp) console.log(`${bold("mcp    ")} ${dim("off (NGOBE_MCP=0)")}`);
  else {
    const { connectServer, serversFor, statusLine } = await import("./mcp/index.js");
    const { specs, untrusted, warnings } = serversFor(config, isTrusted(config.cwd, config.stateDir));
    for (const w of warnings) console.log(`${bold("mcp    ")} ${warn(w)}`);
    const results = await Promise.all(specs.map((s) => connectServer(s, { lean: config.toolProfile !== "full" })));
    await Promise.all(results.map((r) => r.client?.close()));
    for (const { status } of results) console.log(`${bold("mcp    ")} ${(status.state === "connected" ? ok : status.state === "failed" ? bad : (s: string) => dim(s))(statusLine(status))}`);
    if (untrusted.length) console.log(`${bold("mcp    ")} ${warn(`.mcp.json servers not used here (folder not trusted): ${untrusted.join(", ")}`)}`);
    if (!specs.length && !untrusted.length) console.log(`${bold("mcp    ")} ${dim("no servers (ngobe mcp add)")}`);
  }

  // --- search and official sources ----------------------------------------------------
  if (config.searchProviders.length === 0) {
    console.log(`${bold("search ")} ${warn("no provider configured: web_search is off (set BRAVE_API_KEY, TAVILY_API_KEY or NGOBE_SEARXNG_URL)")}`);
  }
  for (const provider of config.searchProviders) {
    try {
      const [r, ms] = await timed(() => webSearch({ ...config, searchProviders: [provider] }, "ngobe cli health check", { count: 1 }));
      console.log(`${bold("search ")} ${ok(`${provider} (${ms} ms, ${r.results.length} result)`)}`);
    } catch (err) {
      console.log(`${bold("search ")} ${bad(`${provider}: ${message(err)}`)}`);
    }
  }
  try {
    const [info, ms] = await timed(() => latestVersion("node", undefined, { config }));
    console.log(`${bold("sources")} ${ok(`official release metadata reachable (nodejs.org: ${info.stable?.version}, ${ms} ms)`)}`);
  } catch (err) {
    console.log(`${bold("sources")} ${bad(`official release metadata unreachable: ${message(err)}`)}`);
  }

  // --- memory ------------------------------------------------------------------------
  const memory = Memory.open(config, (m) => console.log(`${bold("memory ")} ${bad(m)}`));
  if (!config.memory) console.log(`${bold("memory ")} ${warn("off (NGOBE_MEMORY=0)")}`);
  if (memory) {
    const facts = memory.listFacts().length;
    const s = memory.runStats(30);
    const size = fs.statSync(memory.file).size;
    console.log(`${bold("memory ")} ${(memory.enabled ? ok : warn)(`${memory.file} (${(size / 1024).toFixed(0)} KB${memory.enabled ? "" : ", disabled"}): ${facts} facts, ${memory.docsCount()} docs pages indexed`)}`);
    if (s.runs) {
      console.log(dim(`         30 days: ${s.runs} runs, ${Math.round((s.completed / s.runs) * 100)}% completed; tests ${s.tests_passed} passed / ${s.tests_failed} failed`));
      console.log(dim(`         average run ${(s.avg_ms / 1000).toFixed(1)}s (model ${(s.avg_model_ms / 1000).toFixed(1)}s, tools ${(s.avg_tool_ms / 1000).toFixed(1)}s)`));
      const last = memory.recentRuns(1)[0];
      if (last) console.log(dim(`         last run: ${last.outcome}${last.tests ? `, tests ${last.tests}` : ""} (${last.started_at.slice(0, 16).replace("T", " ")})`));
    }
    const clusters = memory.failureClusters(14).slice(0, 3);
    for (const c of clusters) console.log(dim(`         recent failures: ${c.count}× ${c.tools.join("/")}: ${c.sample.slice(0, 100)}`));
    memory.close();
  }
  console.log(`${bold("cache  ")} ${config.cacheDir} ${dim(`(${(dirSize(config.cacheDir) / 1024 ** 2).toFixed(1)} MB)`)}`);
  return healthy ? 0 : 1;
}

/**
 * Memory the OS can hand out now. os.freemem leaves out reclaimable caches: Linux reports them
 * as MemAvailable, macOS as inactive, speculative and purgeable pages (vm_stat).
 */
function availableMemory(): number {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync("/proc/meminfo", "utf8"));
    if (m) return Number(m[1]) * 1024;
  } catch {
    // not Linux
  }
  if (os.platform() === "darwin") {
    try {
      const out = execFileSync("vm_stat", { encoding: "utf8", timeout: 3000 });
      const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
      const pages = (label: string) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
      return (pages("free") + pages("inactive") + pages("speculative") + pages("purgeable")) * pageSize;
    } catch {
      // fall through
    }
  }
  return os.freemem();
}

/** Model size from llama.cpp metadata or Docker Model Runner's /models, checked against memory. */
async function modelResources(config: Config, models: ModelInfo[], available: number): Promise<string[]> {
  const out: string[] = [];
  const meta = models.find((m) => m.id === config.model)?.raw.meta as { size?: number; n_params?: number; n_ctx_train?: number } | undefined;
  let size = meta?.size;
  let detail = meta ? `${meta.n_params ? `${(meta.n_params / 1e9).toFixed(1)}B params, ` : ""}${meta.n_ctx_train ? `trained context ${meta.n_ctx_train}` : ""}` : "";
  if (!size && config.baseURL.includes("/engines")) {
    // Docker Model Runner lists sizes and quantization on its native API.
    try {
      const origin = new URL(config.baseURL).origin;
      const { data } = await httpJson<{ tags?: string[]; config?: { size?: string; quantization?: string; parameters?: string } }[]>(`${origin}/models`, { timeoutMs: 5_000, retries: 0 });
      const m = data.find((x) => x.tags?.some((t) => t === config.model || t.startsWith(`${config.model}:`)));
      if (m?.config) {
        detail = [m.config.parameters && `${m.config.parameters} params`, m.config.quantization].filter(Boolean).join(", ");
        const g = /([\d.]+)\s*GiB/i.exec(m.config.size ?? "");
        const mb = /([\d.]+)\s*MiB/i.exec(m.config.size ?? "");
        size = g ? Number(g[1]) * 1024 ** 3 : mb ? Number(mb[1]) * 1024 ** 2 : undefined;
      }
    } catch {
      // not Docker Model Runner, or an older version
    }
  }
  if (!size) {
    out.push(dim(`size unknown${detail ? ` (${detail})` : ""}; keep model + KV cache under ~${gib(os.totalmem() * 0.7)} on this machine`));
    return out;
  }
  // Weights plus KV cache and runtime overhead; 1.5 GiB is a conservative allowance for 8-16k context.
  const need = size + 1.5 * 1024 ** 3;
  const line = `weights ${gib(size)}${detail ? ` (${detail})` : ""}; ~${gib(need)} with KV cache`;
  // Free memory can't tell us whether this model is already loaded (and so already counted as
  // used), so judge the fit by total RAM and report free memory separately.
  if (need > os.totalmem() * 0.85) out.push(bad(`${line}: too large for ${gib(os.totalmem())} RAM`));
  else out.push(ok(`${line}; fits in ${gib(os.totalmem())} RAM (${gib(available)} free right now)`));
  if (available < 1024 ** 3) out.push(warn(`only ${gib(available)} free: the system is short of memory`));
  return out;
}

/** If the configured endpoint is down, look for Docker Model Runner or Ollama on their usual ports. */
async function suggestEndpoint(config: Config): Promise<string | null> {
  const candidates = ["http://localhost:12434/engines/v1", "http://localhost:11434/v1"].filter((u) => !config.baseURL.startsWith(u));
  for (const url of candidates) {
    try {
      await httpJson(`${url}/models`, { timeoutMs: 2_000, retries: 0 });
      return `an OpenAI-compatible endpoint answers at ${url}; set NGOBE_BASE_URL=${url}`;
    } catch {
      // not there
    }
  }
  return config.baseURL.includes("12434") ? "is Docker Model Runner's host TCP access on? (docker desktop enable model-runner --tcp 12434)" : null;
}

function which(bin: string): Promise<boolean> {
  return new Promise((resolve) => execFile(bin, ["--version"], { timeout: 5_000 }, (err) => resolve(!err)));
}

function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath, entry.name)).size;
    }
  } catch {
    // missing directory
  }
  return total;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
