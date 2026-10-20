import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import picomatch from "picomatch";
import type { Tool } from "../types.js";
import { listFiles } from "./files.js";
import { isInside, reqStr, resolveInside } from "./util.js";

/** Paths shown, newest first, like Claude Code; more and the result says where the rest are. */
const MAX = 100;
/** Sorting by modification time costs a stat per file: past this many matches, by name. */
const MAX_STAT = 5_000;

/**
 * fast-glob happily walks "../" and absolute patterns, so refuse any pattern whose static
 * base directory is outside cwd. ".." inside the dynamic part (after a wildcard or brace)
 * can't escape: the walker never yields "..".
 */
export function assertPatternInside(pattern: string, cwd: string): void {
  for (const task of fg.generateTasks(pattern, { cwd })) {
    if (!isInside(cwd, task.base)) throw new Error(`pattern reaches outside the project directory: ${pattern}`);
  }
}

/**
 * Files under cwd matching a pattern (fast-glob syntax: "*.ts" is the top level, "**\/*.ts" any
 * depth), leaving out what listFiles leaves out: .gitignored files, .git, node_modules.
 */
export async function findFiles(pattern: string, cwd: string, signal?: AbortSignal): Promise<string[]> {
  assertPatternInside(pattern, cwd);
  const isMatch = picomatch(pattern);
  const found = new Set<string>();
  // List only below the pattern's fixed part: "lib/**/*.dart" never walks the rest.
  for (const base of new Set(fg.generateTasks(pattern, { cwd }).map((t) => t.base))) {
    const prefix = base === "." || base === "" ? "" : `${base}/`;
    for (const f of await listFiles(path.join(cwd, base), signal)) if (isMatch(prefix + f)) found.add(prefix + f);
  }
  return [...found];
}

/** "graft/nodes/ (150), lib/services/ (2)": the folders holding most of the paths. */
function whereMost(paths: string[]): string {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const parts = p.split("/");
    const folder = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/` : "./";
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([f, n]) => `${f} (${n})`)
    .join(", ");
}

export const glob: Tool = {
  name: "glob",
  label: "Glob",
  description: 'Find files by name pattern, e.g. "**/*.ts" or "src/**/test_*.py". Gitignored files are left out. Newest first, up to 100; past that it says which folders hold the rest.',
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Directory to search in (default: the project root)" },
    },
    required: ["pattern"],
  },
  lean: {
    description: 'Find files by name pattern, e.g. "src/**/*.ts".',
    parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  },
  risk: "safe",
  describe: (a) => `glob ${a.pattern}${a.path ? ` in ${a.path}` : ""}`,
  target: (a) => `${a.pattern}${a.path ? ` in ${a.path}` : ""}`,
  activity: (a) => `Finding ${a.pattern}`,
  summarize(_a, output) {
    if (output.startsWith("No files")) return { summary: "No files found" };
    const n = Number(/^(\d+) files match/.exec(output)?.[1] ?? output.split("\n").filter(Boolean).length);
    return { summary: `Found ${n} file${n === 1 ? "" : "s"}` };
  },
  async run(args, ctx) {
    const pattern = reqStr(args, "pattern");
    const base = typeof args.path === "string" && args.path ? args.path : ".";
    const dir = resolveInside(ctx.cwd, base);
    const files = await findFiles(pattern, dir, ctx.signal);
    if (files.length === 0) return "No files matched.";
    const rel = (f: string) => path.relative(ctx.cwd, path.join(dir, f));
    let sorted: string[];
    if (files.length <= MAX_STAT) {
      const mtimes = await Promise.all(files.map((f) => fs.stat(path.join(dir, f)).then((s) => s.mtimeMs, () => 0)));
      sorted = files.map((f, i) => ({ f: rel(f), t: mtimes[i] })).sort((a, b) => b.t - a.t || a.f.localeCompare(b.f)).map((x) => x.f);
    } else {
      sorted = files.map(rel).sort();
    }
    if (sorted.length <= MAX) return sorted.join("\n");
    // A long list costs the model a minute to read on a CPU and hides where the code is.
    const which = sorted.length <= MAX_STAT ? `the ${MAX} newest` : `the first ${MAX} by name`;
    return `${sorted.length} files match; showing ${which}. Most are in: ${whereMost(sorted)}. Narrow the pattern or path, or use project_overview.\n${sorted.slice(0, MAX).join("\n")}`;
  }
};
