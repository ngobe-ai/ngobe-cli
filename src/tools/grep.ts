import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { Tool } from "../types.js";
import { reqStr } from "./util.js";
import { IGNORE } from "./glob.js";

const MAX_MATCHES = 100;

// Pure-JS grep to keep dependencies at zero. Swap for `rg --json` later for speed.
export const grep: Tool = {
  name: "grep",
  description: "Search file contents with a JavaScript regular expression. Returns path:line:text, up to 100 matches.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression" },
      glob: { type: "string", description: 'Limit to files matching this glob (default "**/*")' },
    },
    required: ["pattern"],
  },
  risk: "safe",
  describe: (a) => `grep /${a.pattern}/${a.glob ? " in " + a.glob : ""}`,
  async run(args, ctx) {
    const re = new RegExp(reqStr(args, "pattern"));
    const pattern = typeof args.glob === "string" && args.glob ? args.glob : "**/*";
    const files = await fg(pattern, { cwd: ctx.cwd, ignore: IGNORE });

    const hits: string[] = [];
    for (const file of files.sort()) {
      if (hits.length >= MAX_MATCHES) break;
      const abs = path.join(ctx.cwd, file);
      let text: string;
      try {
        const stat = await fs.stat(abs);
        if (stat.size > 1_000_000) continue;
        text = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\0")) continue; // binary
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
        if (re.test(lines[i])) hits.push(`${file}:${i + 1}:${lines[i].slice(0, 200)}`);
      }
    }
    if (hits.length === 0) return "No matches.";
    return hits.join("\n") + (hits.length >= MAX_MATCHES ? "\n[match limit reached]" : "");
  },
};
