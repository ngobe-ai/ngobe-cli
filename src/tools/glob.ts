import fg from "fast-glob";
import type { Tool } from "../types.js";
import { isInside, reqStr } from "./util.js";

const IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/target/**"];

/**
 * fast-glob limited to the project. It happily walks "../" and absolute patterns, so
 * refuse any pattern whose static base directory is outside cwd. ".." inside the
 * dynamic part (after a wildcard or brace) can't escape: the walker never yields "..".
 */
export async function findFiles(pattern: string, cwd: string): Promise<string[]> {
  for (const task of fg.generateTasks(pattern, { cwd })) {
    if (!isInside(cwd, task.base)) throw new Error(`pattern reaches outside the project directory: ${pattern}`);
  }
  return fg(pattern, { cwd, ignore: IGNORE });
}

export const glob: Tool = {
  name: "glob",
  description: 'Find files by glob pattern, e.g. "src/**/*.ts". Returns up to 200 paths.',
  parameters: {
    type: "object",
    properties: { pattern: { type: "string" } },
    required: ["pattern"],
  },
  risk: "safe",
  describe: (a) => `glob ${a.pattern}`,
  async run(args, ctx) {
    const files = await findFiles(reqStr(args, "pattern"), ctx.cwd);
    if (files.length === 0) return "No files matched.";
    const shown = files.sort().slice(0, 200);
    return shown.join("\n") + (files.length > 200 ? `\n[${files.length - 200} more not shown]` : "");
  },
};
