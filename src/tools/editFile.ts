import fs from "node:fs/promises";
import { diffPreview, langOf } from "../diff.js";
import type { Args, PreviewLine, Tool, ToolContext } from "../types.js";
import { assertUnchanged, hashText, isGitInternal, isSecretPath, reqStr, resolveInside } from "./util.js";

export interface Replacement {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

const needs = (a: Args) => (typeof a.path === "string" && (isSecretPath(a.path) || isGitInternal(a.path)) ? "explicit" : "approval");

/**
 * Apply replacements to a file the agent has read, all or nothing, and report the edited lines
 * (numbered like read_file) so the model can check the result.
 */
async function applyEdits(path: string, edits: Replacement[], ctx: ToolContext): Promise<string> {
  const abs = resolveInside(ctx.cwd, path);
  const original = await fs.readFile(abs, "utf8").catch(() => null);
  if (original === null) throw new Error(`${path} does not exist. To create a file, use write_file.`);
  // Editing a file the agent never looked at is guessing; read_file first.
  if (ctx.files && !ctx.files.has(abs)) throw new Error(`Read ${path} with read_file before editing it.`);
  assertUnchanged(ctx, abs, original, path);

  const crlf = original.includes("\r\n");
  let text = original;
  const touched: number[] = []; // character offsets of the replacements
  for (const [i, e] of edits.entries()) {
    const label = edits.length > 1 ? `edit ${i + 1}: ` : "";
    // Models send "\n" line endings; still match CRLF files, and keep them CRLF.
    const oldStr = crlf && !e.old_string.includes("\r\n") ? e.old_string.replace(/\n/g, "\r\n") : e.old_string;
    const newStr = crlf && !e.old_string.includes("\r\n") ? e.new_string.replace(/\r?\n/g, "\r\n") : e.new_string;
    if (oldStr === "") throw new Error(`${label}old_string is empty. To create a file, use write_file.`);
    if (oldStr === newStr) throw new Error(`${label}old_string and new_string are the same; nothing would change.`);
    const count = text.split(oldStr).length - 1;
    if (count === 0) {
      // A whole new file as new_string, with a made-up old_string (seen live on a starter file).
      const whole = e.new_string.split("\n").length >= 10 ? " To replace the whole file, call write_file with its complete new content." : "";
      throw new Error(`${label}old_string was not found in ${path}. Re-read the file and copy the text exactly, including indentation.${whole}`);
    }
    if (count > 1 && !e.replace_all) {
      throw new Error(`${label}old_string matches ${count} places in ${path}. Add surrounding lines to make it unique, or set replace_all to change every one.`);
    }
    let from = 0;
    let at = text.indexOf(oldStr, from);
    while (at >= 0) {
      touched.push(at);
      text = text.slice(0, at) + newStr + text.slice(at + oldStr.length);
      from = at + newStr.length;
      at = e.replace_all ? text.indexOf(oldStr, from) : -1;
    }
  }

  await fs.writeFile(abs, text);
  ctx.files?.set(abs, hashText(text));
  // The transcript shows the real diff (line numbers, context), like Claude Code.
  const d = diffPreview(original, text, langOf(path));
  ctx.report?.({ summary: `Updated ${path} (+${d.added} −${d.removed})`, preview: d.lines });
  return `The file ${path} has been updated. The edited lines now read:\n${snippet(text, touched)}`;
}

/** Numbered lines around the edits (up to 3 regions), like read_file output. */
function snippet(text: string, offsets: number[]): string {
  const lines = text.split(/\r?\n/);
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;
  const ranges: [number, number][] = [];
  for (const line of [...new Set(offsets.map(lineOf))].sort((a, b) => a - b)) {
    const [s, e] = [Math.max(1, line - 3), Math.min(lines.length, line + 5)];
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  }
  return ranges
    .slice(0, 3)
    .map(([s, e]) => lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(6)}\t${l}`).join("\n"))
    .join("\n     …\n");
}

/** "+3 −1" and the changed lines, for the transcript. */
function diffView(edits: Replacement[]): { summary: string; preview: PreviewLine[] } {
  let added = 0;
  let removed = 0;
  const preview: PreviewLine[] = [];
  for (const e of edits) {
    const oldLines = e.old_string.split("\n");
    const newLines = e.new_string === "" ? [] : e.new_string.split("\n");
    // Drop leading/trailing lines both sides share, so only the real change shows.
    let head = 0;
    while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
    let tail = 0;
    while (tail < oldLines.length - head && tail < newLines.length - head && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;
    const gone = oldLines.slice(head, oldLines.length - tail);
    const came = newLines.slice(head, newLines.length - tail);
    removed += gone.length;
    added += came.length;
    for (const l of gone) preview.push({ text: `- ${l}`, tone: "remove" });
    for (const l of came) preview.push({ text: `+ ${l}`, tone: "add" });
  }
  const shown = preview.slice(0, 10);
  if (preview.length > 10) shown.push({ text: `… ${preview.length - 10} more lines`, tone: "dim" });
  return { summary: `+${added} −${removed}`, preview: shown };
}

function replacement(a: Args): Replacement {
  return { old_string: reqStr(a, "old_string"), new_string: reqStr(a, "new_string", true), replace_all: a.replace_all === true };
}

const preview = (v: unknown) => {
  const s = String(v ?? "").replace(/\n/g, "\\n");
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
};

export const editFile: Tool = {
  name: "edit_file",
  label: "Edit",
  description:
    "Replace exact text in a file you have read. old_string must match the file exactly (indentation included) and only once, unless replace_all is true. Returns the edited lines so you can check them.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to replace" },
      new_string: { type: "string", description: "Replacement text (empty to delete)" },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
    },
    required: ["path", "old_string", "new_string"],
  },
  lean: {
    description: "Replace exact text in a file you have read. old_string must match exactly and only once, unless replace_all is true.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } },
      required: ["path", "old_string", "new_string"],
    },
  },
  aliases: { old_str: "old_string", new_str: "new_string", file_path: "path" },
  risk: "write",
  needs,
  describe: (a) => `edit ${a.path}\n    - ${preview(a.old_string)}\n    + ${preview(a.new_string)}`,
  activity: (a) => `Editing ${a.path}`,
  summarize: (a) => diffView([{ old_string: String(a.old_string ?? ""), new_string: String(a.new_string ?? "") }]),
  async run(args, ctx) {
    return applyEdits(reqStr(args, "path"), [replacement(args)], ctx);
  },
};

export const multiEdit: Tool = {
  name: "multi_edit",
  label: "MultiEdit",
  description:
    "Make several edit_file-style replacements in one file, in order, all or nothing. Use it instead of repeated edit_file calls on the same file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["path", "edits"],
  },
  aliases: { file_path: "path" },
  risk: "write",
  needs,
  describe: (a) => `edit ${a.path} (${Array.isArray(a.edits) ? a.edits.length : 0} changes)`,
  activity: (a) => `Editing ${a.path}`,
  summarize: (a) =>
    diffView((Array.isArray(a.edits) ? a.edits : []).map((e: Args) => ({ old_string: String(e.old_string ?? ""), new_string: String(e.new_string ?? "") }))),
  async run(args, ctx) {
    const edits = Array.isArray(args.edits) ? (args.edits as Args[]).map(replacement) : [];
    if (edits.length === 0) throw new Error("edits must contain at least one change");
    return applyEdits(reqStr(args, "path"), edits, ctx);
  },
};
