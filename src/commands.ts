import { spawn } from "node:child_process";
import { childEnv } from "./childEnv.js";
import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline/promises";
import { configFilePath, redactedConfig, type LoadedConfig } from "./config.js";
import { Memory } from "./memory/store.js";
import { detectProject } from "./project.js";
import { installedVersions } from "./releases/installed.js";
import { compareVersions, latestVersion } from "./releases/versions.js";
import { bold, cyan, dim, green, red, yellow } from "./ui.js";
import { searchDocs, webSearch, type SearchResponse } from "./web/search.js";

/** Direct commands: no model involved (except "learn propose" and "benchmark"). Returns the exit code. */
export async function runCommand(loaded: LoadedConfig): Promise<number> {
  try {
    switch (loaded.command) {
      case "test":
        return await cmdTest(loaded);
      case "search":
        return await cmdSearch(loaded);
      case "docs":
        return await cmdDocs(loaded);
      case "version":
        return await cmdVersion(loaded);
      case "memory":
        return await cmdMemory(loaded);
      case "learn":
        return await (await import("./learn.js")).cmdLearn(loaded);
      case "benchmark":
        return await (await import("./bench.js")).cmdBenchmark(loaded);
      case "doctor":
        return await (await import("./doctor.js")).cmdDoctor(loaded);
      case "config":
        return cmdConfig(loaded);
      case "update":
        return await (await import("./update.js")).cmdUpdate(loaded);
      default:
        console.error(`unknown command ${loaded.command}`);
        return 2;
    }
  } catch (err) {
    console.error(red(err instanceof Error ? err.message : String(err)));
    return 1;
  }
}

function openMemory(loaded: LoadedConfig): Memory | null {
  return Memory.open(loaded.config, (m) => console.error(yellow(m)));
}

async function cmdTest(loaded: LoadedConfig): Promise<number> {
  const { config } = loaded;
  const project = await detectProject(config.cwd);
  const memory = openMemory(loaded);
  // Only commands learned from runs that passed (or set by the user), never ones the model stored.
  const learned = memory?.enabled
    ? memory.recall(config.cwd, 50, ["command"]).find((f) => f.key === "test" && (f.source === "observed" || f.source === "user"))
    : undefined;
  const command = project.commands.test ?? learned?.value;
  if (!command) {
    console.error(red("No test command found (checked package.json, pubspec.yaml, composer.json, pyproject.toml, Cargo.toml, go.mod, Makefile)."));
    return 1;
  }
  if (!project.commands.test) {
    // A remembered command isn't in the project's manifests: show it and ask before running it.
    if (!process.stdin.isTTY) {
      console.error(red(`Not running the remembered test command without confirmation (no terminal): ${command}`));
      return 1;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(`Run the remembered test command \`${command}\`? [y/N] `);
    rl.close();
    if (answer.trim().toLowerCase() !== "y") return 1;
  }
  console.error(dim(`$ ${command}${project.commands.test ? "" : " (learned from an earlier run)"}`));
  const started = Date.now();
  const code = await new Promise<number>((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd: config.cwd, env: childEnv(), stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (c) => resolve(c ?? 1));
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.error(code === 0 ? green(`✓ tests passed (${secs}s)`) : red(`✗ tests failed with exit code ${code} (${secs}s)`));
  if (memory?.enabled) {
    memory.recordRun({
      id: crypto.randomUUID().slice(0, 8),
      project: config.cwd,
      command: "test",
      mode: "direct",
      model: "",
      variant: "",
      started_at: new Date(started).toISOString(),
      duration_ms: Date.now() - started,
      model_ms: 0,
      tool_ms: Date.now() - started,
      turns: 0,
      tool_calls: 0,
      tool_errors: 0,
      tokens_in: 0,
      tokens_out: 0,
      tokens_estimated: 0,
      outcome: "completed",
      tests: code === 0 ? "passed" : "failed",
    });
    if (code === 0) memory.remember({ project: config.cwd, kind: "command", key: "test", value: command, source: "observed", confidence: 0.6, ttlDays: 90 });
    memory.close();
  }
  return code;
}

function printSearch(r: SearchResponse, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  r.results.forEach((x, i) => {
    console.log(`${bold(`${i + 1}. ${x.title}`)}${x.official ? cyan(" [official]") : ""}\n   ${x.url}\n   ${dim(x.snippet)}${x.published ? dim(` (${x.published})`) : ""}`);
  });
  console.log(dim(`${r.provider}, ${r.fetchedAt}${r.failures.length ? `; ${r.failures.join("; ")}` : ""}`));
}

async function cmdSearch(loaded: LoadedConfig): Promise<number> {
  if (!loaded.prompt) {
    console.error("Usage: ngobe search <query>");
    return 2;
  }
  printSearch(await webSearch(loaded.config, loaded.prompt), loaded.json);
  return 0;
}

async function cmdDocs(loaded: LoadedConfig): Promise<number> {
  const [tech, ...rest] = loaded.args;
  if (!tech || rest.length === 0) {
    console.error("Usage: ngobe docs <technology> <query>   e.g. ngobe docs flutter navigation drawer");
    return 2;
  }
  const query = rest.join(" ");
  if (loaded.config.searchProviders.length) {
    printSearch(await searchDocs(loaded.config, tech, query), loaded.json);
    return 0;
  }
  const memory = openMemory(loaded);
  const hits = memory?.searchDocs(query, tech.toLowerCase()) ?? [];
  memory?.close();
  if (hits.length === 0) {
    console.error(red("No web search provider is configured and no pages for this technology are in the local docs index."));
    return 1;
  }
  console.log(dim("Local docs index (pages fetched earlier; may be stale):"));
  hits.forEach((h, i) => console.log(`${bold(`${i + 1}. ${h.title}`)}\n   ${h.url} ${dim(`(fetched ${h.fetched_at})`)}\n   ${dim(h.snippet)}`));
  return 0;
}

async function cmdVersion(loaded: LoadedConfig): Promise<number> {
  const name = loaded.args[0];
  if (!name) {
    console.error("Usage: ngobe version <name> [--ecosystem npm|pypi|pub|packagist|crates|github|…]");
    return 2;
  }
  const { config } = loaded;
  const eco = loaded.ecosystem || undefined;
  const [latest, installed] = await Promise.all([
    latestVersion(name, eco, { config }),
    installedVersions(name, config.cwd, eco).catch(() => []),
  ]);
  if (loaded.json) {
    console.log(JSON.stringify({ latest, installed }, null, 2));
    return 0;
  }
  const s = latest.stable;
  console.log(`${bold(latest.name)} ${dim(`(${latest.ecosystem})`)} — latest ${s ? `${s.channel} ${bold(s.version)}${s.date ? ` (released ${s.date})` : ""}` : "stable: none found"}`);
  for (const o of latest.other) console.log(`  ${o.channel} ${o.version}${o.date ? ` (released ${o.date})` : ""}`);
  for (const i of installed) {
    const v = /\d+(\.\d+)+\S*/.exec(i.version)?.[0];
    const rel = !s || !v || /^[\^~<>=]/.test(i.version) ? "" : compareVersions(v, s.version) === 0 ? green(" — up to date") : compareVersions(v, s.version) < 0 ? yellow(" — behind") : dim(" — newer than stable");
    console.log(`installed: ${i.version} ${dim(`(${i.source})`)}${rel}`);
  }
  if (installed.length === 0) console.log(dim("installed: not found here"));
  console.log(dim(`source: ${latest.source}\nchecked: ${latest.checkedAt}`));
  if (latest.note) console.log(dim(`note: ${latest.note}`));
  return 0;
}

async function cmdMemory(loaded: LoadedConfig): Promise<number> {
  const [sub = "list", arg] = loaded.args;
  const memory = openMemory(loaded);
  if (!memory) {
    console.error(red("Memory is off (NGOBE_MEMORY=0) or SQLite is unavailable in this runtime (needs Node 22.13+ or Bun)."));
    return 1;
  }
  try {
    switch (sub) {
      case "list": {
        const facts = memory.listFacts(loaded.json ? undefined : loaded.config.cwd);
        if (loaded.json) {
          console.log(JSON.stringify(facts, null, 2));
          break;
        }
        console.log(dim(`${memory.file} — ${memory.enabled ? "enabled" : "disabled"}; facts for this project and global ones:`));
        if (facts.length === 0) console.log(dim("(none yet)"));
        for (const f of facts) {
          const expired = f.expires_at && f.expires_at < new Date().toISOString() ? red(" expired") : "";
          console.log(`#${f.id} ${f.project === "*" ? "global " : ""}${f.kind} ${bold(f.key)}: ${f.value} ${dim(`[${f.source}, ${f.confidence.toFixed(2)}, ${f.updated_at.slice(0, 10)}${f.expires_at ? `, expires ${f.expires_at.slice(0, 10)}` : ""}]`)}${expired}`);
        }
        break;
      }
      case "show": {
        const f = memory.getFact(Number(arg));
        if (!f) throw new Error(`no fact #${arg}`);
        console.log(JSON.stringify(f, null, 2));
        break;
      }
      case "export": {
        const data = {
          exported_at: new Date().toISOString(),
          facts: memory.listFacts(),
          runs: memory.recentRuns(500),
          failure_clusters: memory.failureClusters(365),
          variants: memory.variants(),
        };
        const text = JSON.stringify(data, null, 2);
        if (arg) {
          fs.writeFileSync(arg, text);
          console.error(green(`exported to ${arg}`));
        } else {
          console.log(text);
        }
        break;
      }
      case "delete":
        if (!memory.deleteFact(Number(arg))) throw new Error(`no fact #${arg}`);
        console.error(green(`deleted #${arg}`));
        break;
      case "clear": {
        if (!loaded.yes) {
          if (!process.stdin.isTTY) throw new Error("memory clear needs --yes when not run from a terminal");
          const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
          const answer = await rl.question("Delete all learned facts, run history, failures and the docs index? [y/N] ");
          rl.close();
          if (answer.trim().toLowerCase() !== "y") return 1;
        }
        memory.clear();
        console.error(green("memory cleared (prompt variants kept)"));
        break;
      }
      case "disable":
      case "enable":
        memory.setEnabled(sub === "enable");
        console.error(green(`memory ${sub}d`));
        break;
      case "path":
        console.log(memory.file);
        break;
      default:
        console.error("Usage: ngobe memory [list|show <id>|export [file]|delete <id>|clear|disable|enable|path]");
        return 2;
    }
    return 0;
  } finally {
    memory.close();
  }
}

function cmdConfig(loaded: LoadedConfig): number {
  const file = configFilePath();
  console.log(JSON.stringify({ configFile: file, configFileExists: fs.existsSync(file), ...redactedConfig(loaded.config) }, null, 2));
  return 0;
}

