import fg from "fast-glob";
import type { Tool } from "../types.js";
import { reqStr } from "./util.js";

export const IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/target/**"];

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
    const files = await fg(reqStr(args, "pattern"), { cwd: ctx.cwd, ignore: IGNORE });
    if (files.length === 0) return "No files matched.";
    const shown = files.sort().slice(0, 200);
    return shown.join("\n") + (files.length > 200 ? `\n[${files.length - 200} more not shown]` : "");
  },
};
