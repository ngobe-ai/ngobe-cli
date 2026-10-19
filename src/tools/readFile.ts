import fs from "node:fs/promises";
import type { Tool } from "../types.js";
import { hashText, isSecretPath, optInt, reqStr, resolveInside } from "./util.js";

export const readFile: Tool = {
  name: "read_file",
  description:
    "Read a text file. Output lines are prefixed with line numbers. Use offset/limit for large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the project root" },
      offset: { type: "integer", description: "1-based line to start from (default 1)", minimum: 1 },
      limit: { type: "integer", description: "Max lines to return (default 500)", minimum: 1 },
    },
    required: ["path"],
  },
  risk: "safe",
  needs: (a) => (typeof a.path === "string" && isSecretPath(a.path) ? "explicit" : "none"),
  describe: (a) => `read ${a.path}`,
  async run(args, ctx) {
    const abs = resolveInside(ctx.cwd, reqStr(args, "path"));
    const text = await fs.readFile(abs, "utf8");
    ctx.files?.set(abs, hashText(text));
    const lines = text.split("\n");
    const start = Math.max(1, optInt(args, "offset") ?? 1);
    const limit = optInt(args, "limit") ?? 500;
    const slice = lines.slice(start - 1, start - 1 + limit);
    const body = slice.map((l, i) => `${start + i}\t${l}`).join("\n");
    const more = start - 1 + limit < lines.length ? `\n[${lines.length} lines total; use offset to read more]` : "";
    return body + more;
  },
};
