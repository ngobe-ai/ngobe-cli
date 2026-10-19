import fs from "node:fs/promises";
import path from "node:path";
import type { Tool } from "../types.js";
import { assertUnchanged, hashText, isGitInternal, isSecretPath, reqStr, resolveInside } from "./util.js";

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
  // Secrets, and git internals (hooks and config can run commands), always need a person.
  needs: (a) => (typeof a.path === "string" && (isSecretPath(a.path) || isGitInternal(a.path)) ? "explicit" : "approval"),
  describe: (a) => `write ${a.path} (${String(a.content ?? "").length} chars)`,
  async run(args, ctx) {
    const abs = resolveInside(ctx.cwd, reqStr(args, "path"));
    const content = reqStr(args, "content", true);
    const existing = await fs.readFile(abs, "utf8").catch(() => null);
    if (existing !== null && ctx.files) {
      // Overwriting a file the agent never looked at would silently drop whatever is in it.
      if (!ctx.files.has(abs)) throw new Error(`${args.path} already exists. Read it first, or use edit_file.`);
      assertUnchanged(ctx, abs, existing, String(args.path));
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    ctx.files?.set(abs, hashText(content));
    return `Wrote ${content.length} characters to ${args.path}`;
  },
};
