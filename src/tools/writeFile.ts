import fs from "node:fs/promises";
import path from "node:path";
import type { Tool } from "../types.js";
import { reqStr, resolveInside } from "./util.js";

export const writeFile: Tool = {
  name: "write_file",
  description: "Create a new file or fully overwrite an existing one. Prefer edit_file for changes to existing files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  risk: "write",
  describe: (a) => `write ${a.path} (${String(a.content ?? "").length} chars)`,
  async run(args, ctx) {
    const abs = resolveInside(ctx.cwd, reqStr(args, "path"));
    const content = reqStr(args, "content", true);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    return `Wrote ${content.length} characters to ${args.path}`;
  },
};
