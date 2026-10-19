import fs from "node:fs/promises";
import type { Tool } from "../types.js";
import { assertUnchanged, hashText, isGitInternal, isSecretPath, reqStr, resolveInside } from "./util.js";

export const editFile: Tool = {
  name: "edit_file",
  description:
    "Edit a file by replacing old_str with new_str. old_str must match the file exactly once (including whitespace); add surrounding context if it is not unique.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_str: { type: "string", description: "Exact text to replace" },
      new_str: { type: "string", description: "Replacement text (may be empty to delete)" },
    },
    required: ["path", "old_str", "new_str"],
  },
  risk: "write",
  // Secrets, and git internals (hooks and config can run commands), always need a person.
  needs: (a) => (typeof a.path === "string" && (isSecretPath(a.path) || isGitInternal(a.path)) ? "explicit" : "approval"),
  describe: (a) => `edit ${a.path}\n    - ${preview(a.old_str)}\n    + ${preview(a.new_str)}`,
  async run(args, ctx) {
    const abs = resolveInside(ctx.cwd, reqStr(args, "path"));
    let oldStr = reqStr(args, "old_str");
    let newStr = reqStr(args, "new_str", true);
    const text = await fs.readFile(abs, "utf8");
    assertUnchanged(ctx, abs, text, String(args.path));
    // Models send "\n" line endings; still match CRLF files, and keep them CRLF.
    if (text.includes("\r\n") && !oldStr.includes("\r\n")) {
      oldStr = oldStr.replace(/\n/g, "\r\n");
      newStr = newStr.replace(/\r?\n/g, "\r\n");
    }

    const count = text.split(oldStr).length - 1;
    if (count === 0) throw new Error("old_str was not found. Re-read the file and copy the text exactly.");
    if (count > 1) throw new Error(`old_str matched ${count} times. Include more surrounding context so it matches once.`);

    const updated = text.replace(oldStr, () => newStr); // fn avoids "$&" pattern surprises
    await fs.writeFile(abs, updated);
    ctx.files?.set(abs, hashText(updated));
    return `Edited ${args.path}`;
  },
};

function preview(v: unknown): string {
  const s = String(v ?? "").replace(/\n/g, "\\n");
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
}
