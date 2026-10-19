import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { Tool } from "../types.js";
import { isInside, reqStr, resolveInside } from "./util.js";

const IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/target/**"];
const MAX = 200;

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

/** fast-glob limited to the project. */
export async function findFiles(pattern: string, cwd: string): Promise<string[]> {
  assertPatternInside(pattern, cwd);
  // Linked directories may point anywhere (even /), so don't descend into them.
  return fg(pattern, { cwd, ignore: IGNORE, followSymbolicLinks: false });
}

export const glob: Tool = {
  name: "glob",
  label: "Glob",
  description: 'Find files by name pattern, e.g. "**/*.ts" or "src/**/test_*.py". Newest files first, up to 200.',
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
    const more = Number(/\[(\d+) more/.exec(output)?.[1] ?? 0);
    const n = output.split("\n").filter((l) => l && !l.startsWith("[")).length + more;
    return { summary: `Found ${n} file${n === 1 ? "" : "s"}` };
  },
  async run(args, ctx) {
    const pattern = reqStr(args, "pattern");
    const base = typeof args.path === "string" && args.path ? args.path : ".";
    const dir = resolveInside(ctx.cwd, base);
    const files = await findFiles(pattern, dir);
    if (files.length === 0) return "No files matched.";
    const rel = (f: string) => path.relative(ctx.cwd, path.join(dir, f));
    const mtimes = await Promise.all(files.map((f) => fs.stat(path.join(dir, f)).then((s) => s.mtimeMs, () => 0)));
    const sorted = files.map((f, i) => ({ f: rel(f), t: mtimes[i] })).sort((a, b) => b.t - a.t || a.f.localeCompare(b.f));
    const shown = sorted.slice(0, MAX).map((x) => x.f);
    return shown.join("\n") + (files.length > MAX ? `\n[${files.length - MAX} more not shown]` : "");
  },
};
