import fs from "node:fs";
import type { LoadedConfig } from "./config.js";
import { DEFAULT_WORKING_INSTRUCTIONS } from "./context.js";
import { LLM } from "./llm.js";
import { Memory } from "./memory/store.js";
import { bold, dim, green, red, yellow } from "./ui.js";

/** What a benchmark run stores on a variant (see bench.ts). */
export interface BenchSummary {
  model: string;
  date: string;
  score: number;
  mustPassOk: boolean;
  tasks: { id: string; pass: boolean; mustPass: boolean; error?: string; ms: number }[];
}

/**
 * Outcome reports and prompt-variant management. A variant only replaces the "How to work"
 * section of the system prompt; mode rules, freshness rules, trust rules and every permission
 * check stay fixed in code, so no variant can loosen them. Promotion requires benchmark
 * results with the current model that pass every must-pass task and score at least as well
 * as the prompt in use; the previous prompt is kept for rollback.
 */
export async function cmdLearn(loaded: LoadedConfig): Promise<number> {
  const [sub = "report", name, file] = loaded.args;
  const memory = Memory.open(loaded.config, (m) => console.error(yellow(m)));
  if (!memory) {
    console.error(red("Memory is off (NGOBE_MEMORY=0) or SQLite is unavailable; learning needs it."));
    return 1;
  }
  try {
    const active = memory.meta("active_variant") ?? "default";
    switch (sub) {
      case "report":
        report(memory, loaded, active);
        return 0;
      case "variants":
        for (const v of memory.variants()) {
          const s = v.results ? (JSON.parse(v.results) as BenchSummary) : null;
          console.log(
            `${v.name === active ? green("* ") : "  "}${bold(v.name)} ${dim(`(${v.source}, ${v.created_at.slice(0, 10)})`)} ${
              s ? `score ${(s.score * 100).toFixed(0)}%${s.mustPassOk ? "" : red(" must-pass failed")} with ${s.model} on ${s.date.slice(0, 10)}` : dim("not benchmarked")
            }`,
          );
        }
        if (!memory.variant("default")) console.log(`${active === "default" ? green("* ") : "  "}${bold("default")} ${dim("(builtin, not benchmarked)")}`);
        return 0;
      case "add": {
        if (!name || !file) throw new Error("Usage: ngobe learn add <name> <file with working instructions>");
        memory.saveVariant(name, checkVariant(fs.readFileSync(file, "utf8")), "user");
        console.error(green(`saved variant ${name}; benchmark it with: ngobe benchmark --variant ${name}`));
        return 0;
      }
      case "propose":
        return await propose(memory, loaded, active, name);
      case "promote":
        return promote(memory, loaded, active, name);
      case "rollback": {
        const previous = memory.meta("previous_variant");
        if (!previous) throw new Error("nothing to roll back to");
        memory.setMeta("active_variant", previous === "default" ? null : previous);
        memory.setMeta("previous_variant", active);
        console.error(green(`active prompt: ${previous} (was ${active})`));
        return 0;
      }
      default:
        console.error("Usage: ngobe learn [report|variants|add <name> <file>|propose [name]|promote <name>|rollback]");
        return 2;
    }
  } catch (err) {
    console.error(red(err instanceof Error ? err.message : String(err)));
    return 1;
  } finally {
    memory.close();
  }
}

function report(memory: Memory, loaded: LoadedConfig, active: string): void {
  const stats = memory.runStats(30);
  const tools = memory.toolStats(30);
  const clusters = memory.failureClusters(30);
  if (loaded.json) {
    console.log(JSON.stringify({ runs: stats, tools, failures: clusters, activeVariant: active }, null, 2));
    return;
  }
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");
  console.log(bold("Last 30 days"));
  console.log(`  runs ${stats.runs}, completed ${pct(stats.completed, stats.runs)}; tests passed ${stats.tests_passed}, failed ${stats.tests_failed}`);
  console.log(`  average run ${(stats.avg_ms / 1000).toFixed(1)}s (model ${(stats.avg_model_ms / 1000).toFixed(1)}s, tools ${(stats.avg_tool_ms / 1000).toFixed(1)}s)`);
  console.log(bold("Tool reliability"));
  if (tools.length === 0) console.log(dim("  no tool calls recorded yet"));
  for (const t of tools) {
    const rate = Math.round(t.ok_rate * 100);
    console.log(`  ${t.tool.padEnd(28)} ${String(t.calls).padStart(5)} calls  ${(rate < 70 ? yellow : (s: string) => s)(`${rate}% ok`)}  ${t.avg_ms} ms avg`);
  }
  console.log(bold("Recurring failures") + dim(" (grouped by similarity; a pattern, not a proven cause)"));
  if (clusters.length === 0) console.log(dim("  none"));
  for (const c of clusters.slice(0, 10)) console.log(`  ${String(c.count).padStart(3)}× ${c.tools.join("/")}: ${c.sample} ${dim(`(last ${c.lastSeen.slice(0, 10)})`)}`);
  console.log(`${bold("Prompt")}: ${active} ${dim("(ngobe learn variants)")}`);
}

/** Variant text must be plain working instructions of reasonable size. */
function checkVariant(text: string): string {
  const t = text.replace(/^```\w*\n?|```$/gm, "").trim();
  if (!t) throw new Error("variant is empty");
  if (t.length > 3000) throw new Error("variant is longer than 3000 characters");
  return t;
}

async function propose(memory: Memory, loaded: LoadedConfig, active: string, name?: string): Promise<number> {
  const current = active === "default" ? DEFAULT_WORKING_INSTRUCTIONS : (memory.variant(active)?.prompt ?? DEFAULT_WORKING_INSTRUCTIONS);
  const clusters = memory.failureClusters(30).slice(0, 8);
  const lastBench = memory.variant(active)?.results;
  const failed = lastBench ? (JSON.parse(lastBench) as BenchSummary).tasks.filter((t) => !t.pass).map((t) => t.id) : [];
  const llm = new LLM(loaded.config);
  const res = await llm.chat(
    [
      {
        role: "system",
        content:
          "You improve the working instructions of a terminal coding agent. Reply with only the new instructions: a bullet list of at most 12 short lines, no headings, no code fences. Keep what works; address the observed failures. Do not mention permissions, safety or trust rules (those are fixed elsewhere).",
      },
      {
        role: "user",
        content: `Current instructions:\n${current}\n\nRecurring failures (count, tool, example):\n${clusters.map((c) => `- ${c.count}× ${c.tools.join("/")}: ${c.sample}`).join("\n") || "- none recorded"}\n\nBenchmark tasks failed last time: ${failed.join(", ") || "none recorded"}`,
      },
    ],
    [],
    (chunk) => process.stdout.write(chunk),
    undefined,
  );
  process.stdout.write("\n");
  const variant = name ?? `auto-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
  memory.saveVariant(variant, checkVariant(res.content), `proposed by ${loaded.config.model}`);
  console.error(green(`saved candidate variant ${variant}. It is not active. Next: ngobe benchmark --variant ${variant}`));
  return 0;
}

function promote(memory: Memory, loaded: LoadedConfig, active: string, name?: string): number {
  if (!name) throw new Error("Usage: ngobe learn promote <variant>");
  if (name === active) throw new Error(`${name} is already active`);
  const model = loaded.config.model;
  const results = (n: string) => {
    const r = memory.variant(n)?.results;
    return r ? (JSON.parse(r) as BenchSummary) : null;
  };
  const cand = results(name);
  if (!cand) throw new Error(`benchmark it first: ngobe benchmark --variant ${name}`);
  if (cand.model !== model) throw new Error(`${name} was benchmarked with ${cand.model}; re-run it with ${model}`);
  if (!cand.mustPassOk) {
    throw new Error(`${name} failed must-pass tasks: ${cand.tasks.filter((t) => t.mustPass && !t.pass).map((t) => t.id).join(", ")}`);
  }
  const base = results(active);
  if (!base || base.model !== model) {
    throw new Error(`benchmark the current prompt (${active}) with ${model} first: ngobe benchmark${active === "default" ? "" : ` --variant ${active}`}`);
  }
  if (cand.score < base.score) {
    throw new Error(`${name} scored ${(cand.score * 100).toFixed(0)}%, below ${active} at ${(base.score * 100).toFixed(0)}%; not promoted`);
  }
  memory.setMeta("previous_variant", active);
  memory.setMeta("active_variant", name === "default" ? null : name);
  console.error(green(`promoted ${name} (${(cand.score * 100).toFixed(0)}% vs ${(base.score * 100).toFixed(0)}%). Undo with: ngobe learn rollback`));
  return 0;
}
