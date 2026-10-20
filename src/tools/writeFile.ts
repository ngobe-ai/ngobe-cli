import fs from "node:fs/promises";
import path from "node:path";
import type { Tool } from "../types.js";
import { assertUnchanged, hashText, isGitInternal, isSecretPath, reqStr, resolveInside } from "./util.js";
import { createdPreview, diffPreview, langOf } from "../diff.js";

export const writeFile: Tool = {
  name: "write_file",
  label: "Write",
  description:
    "Create a new file, or replace a whole file you have read. For changes to an existing file, prefer edit_file. Parent directories are created.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  lean: {
    description: "Create a file, or overwrite one you have read.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  aliases: { file_path: "path" },
  risk: "write",
  // Secrets, and git internals (hooks and config can run commands), always need a person.
  needs: (a) => (typeof a.path === "string" && (isSecretPath(a.path) || isGitInternal(a.path)) ? "explicit" : "approval"),
  describe: (a) => `write ${a.path} (${String(a.content ?? "").length} chars)`,
  activity: (a) => `Writing ${a.path}`,
  summarize(a, output) {
    const lines = String(a.content ?? "").split("\n").length;
    return { summary: `${output.startsWith("Created") ? "Created" : "Wrote"} ${lines} line${lines === 1 ? "" : "s"}` };
  },
  async run(args, ctx) {
    const shown = reqStr(args, "path");
    const abs = resolveInside(ctx.cwd, shown);
    const content = reqStr(args, "content", true);
    const existing = await fs.readFile(abs, "utf8").catch(() => null);
    if (existing !== null && ctx.files) {
      // Overwriting a file the agent never looked at would silently drop whatever is in it.
      if (!ctx.files.has(abs)) throw new Error(`${shown} already exists. Read it first, or use edit_file.`);
      assertUnchanged(ctx, abs, existing, shown);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
    ctx.files?.set(abs, hashText(content));
    const lang = langOf(shown);
    if (existing === null) {
      const count = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
      ctx.report?.({ summary: `Created ${shown} (${count} line${count === 1 ? "" : "s"})`, preview: createdPreview(content, lang) });
    } else {
      const d = diffPreview(existing, content, lang);
      ctx.report?.({ summary: `Updated ${shown} (+${d.added} −${d.removed})`, preview: d.lines });
    }
    const n = content.split("\n").length;
    return `${existing === null ? "Created" : "Updated"} ${shown} (${n} line${n === 1 ? "" : "s"}).`;
  },
};
