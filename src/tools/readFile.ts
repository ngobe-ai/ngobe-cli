import fs from "node:fs/promises";
import type { Tool } from "../types.js";
import { hashText, isSecretPath, optInt, reqStr, resolveInside } from "./util.js";

const MAX_LINE = 2000;

export const readFile: Tool = {
  name: "read_file",
  label: "Read",
  description:
    "Read a text file. Lines come back numbered like cat -n (number, tab, text). Use offset and limit to read part of a long file. You must read a file before editing it.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the project root" },
      offset: { type: "integer", description: "1-based line to start from (default 1)", minimum: 1 },
      limit: { type: "integer", description: "Max lines to return (default 500)", minimum: 1 },
    },
    required: ["path"],
  },
  lean: {
    description: "Read a file (lines numbered). offset/limit page through big files. Read a file before editing it.",
    parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"] },
  },
  aliases: { file_path: "path" },
  risk: "safe",
  needs: (a) => (typeof a.path === "string" && isSecretPath(a.path) ? "explicit" : "none"),
  describe: (a) => `read ${a.path}`,
  activity: (a) => `Reading ${a.path}`,
  summarize(_a, output) {
    if (output.startsWith("(empty file)")) return { summary: "Empty file" };
    const shown = output.split("\n").filter((l) => /^\s*\d+\t/.test(l)).length;
    const total = /\[(\d+) lines total/.exec(output)?.[1];
    return { summary: total ? `Read ${shown} of ${total} lines` : `Read ${shown} line${shown === 1 ? "" : "s"}` };
  },
  async run(args, ctx) {
    const shown = reqStr(args, "path");
    const abs = resolveInside(ctx.cwd, shown);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) throw new Error(`${shown} does not exist. Use glob to find the right path.`);
    if (stat.isDirectory()) throw new Error(`${shown} is a directory. Use glob (e.g. "${shown.replace(/\/$/, "")}/*") to list it.`);
    const buf = await fs.readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) throw new Error(`${shown} is a binary file (${buf.length} bytes); it can't be read as text.`);
    const text = buf.toString("utf8");
    ctx.files?.set(abs, hashText(text));
    if (text.length === 0) return "(empty file)";

    const lines = text.replace(/\n$/, "").split("\n");
    const start = Math.max(1, optInt(args, "offset") ?? 1);
    // Default page size follows the context budget (200 lines at 32k characters).
    const limit = optInt(args, "limit") ?? (ctx.config ? Math.min(500, Math.max(100, Math.floor(ctx.config.maxContextChars / 160))) : 500);
    if (start > lines.length) throw new Error(`${shown} has only ${lines.length} lines; offset ${start} is past the end.`);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const body = slice
      .map((l, i) => `${String(start + i).padStart(6)}\t${l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}… [line truncated]` : l}`)
      .join("\n");
    const end = start - 1 + slice.length;
    const more = end < lines.length ? `\n[${lines.length} lines total; continue with offset=${end + 1}]` : "";
    return body + more;
  },
};
