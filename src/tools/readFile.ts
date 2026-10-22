import fs from "node:fs/promises";
import { extractDocument, human, MAX_LOAD } from "../documents.js";
import type { Tool } from "../types.js";
import { describeImage, showImage } from "../vision.js";
import { wantsUi } from "../design.js";
import { toolOutputLimit } from "../context.js";
import { didYouMean, hashText, isOutsideProject, isSecretPath, mentionsPath, optInt, reqStr, resolveReadable, similarPaths } from "./util.js";

const MAX_LINE = 2000;

export const readFile: Tool = {
  name: "read_file",
  label: "Read",
  description:
    "Read a file. Text and code come back numbered like cat -n (number, tab, text). Other files are converted or described first: PDF, Word, Excel, PowerPoint, OpenDocument, EPUB, RTF, CSV, notebooks, email, SQLite, archives (listed), images, audio, video and executables. Use offset and limit to page through long files. A file outside the project (e.g. ~/Downloads/report.pdf) can be read when the user names it. You must read a file before editing it.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project root, absolute, or starting with ~" },
      offset: { type: "integer", description: "1-based line to start from (default 1)", minimum: 1 },
      limit: { type: "integer", description: "Max lines to return (default 500)", minimum: 1 },
    },
    required: ["path"],
  },
  lean: {
    description: "Read any file: code (numbered lines), PDF, Office, CSV, SQLite, archives, media as text. Read before editing.",
    parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["path"] },
  },
  aliases: { file_path: "path" },
  risk: "safe",
  // An image goes to a vision model on the server, which may have to load first: minutes, on a CPU.
  timeoutMs: 360_000,
  // Secrets always ask. A file outside the project is read without asking only when the user's
  // own request names it ("summarize ~/Downloads/report.pdf"); anything else outside asks.
  needs: (a, ctx) => {
    const p = typeof a.path === "string" ? a.path : "";
    if (isSecretPath(p)) return "explicit";
    if (ctx && isOutsideProject(ctx.cwd, p)) return mentionsPath(ctx.request ?? "", p) ? "none" : "explicit";
    return "none";
  },
  describe: (a) => `read ${a.path}`,
  activity: (a) => `Reading ${a.path}`,
  summarize(_a, output) {
    if (output.startsWith("(empty file)")) return { summary: "Empty file" };
    if (output.startsWith("[")) return { summary: output.slice(1, output.indexOf("]")).slice(0, 120) };
    const shown = output.split("\n").filter((l) => /^\s*\d+\t/.test(l)).length;
    const total = /\[(\d+) lines total/.exec(output)?.[1];
    return { summary: total ? `Read ${shown} of ${total} lines` : `Read ${shown} line${shown === 1 ? "" : "s"}` };
  },
  async run(args, ctx) {
    const shown = reqStr(args, "path");
    const abs = resolveReadable(ctx.cwd, shown);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) {
      const similar = isOutsideProject(ctx.cwd, shown) ? [] : await similarPaths(ctx.cwd, shown, "file");
      throw new Error(`${shown} does not exist.${didYouMean(similar) || " Use glob to find the right path."}`);
    }
    if (stat.isDirectory()) throw new Error(`${shown} is a directory. Use project_overview or glob (e.g. "${shown.replace(/\/$/, "")}/*") to look inside.`);
    // A huge file (a video, a disk image) is identified from its start, never loaded whole.
    const buf = stat.size > MAX_LOAD ? await readStart(abs, MAX_LOAD) : await fs.readFile(abs);

    const config = ctx.config;
    const purpose = wantsUi(ctx.request ?? "") ? "ui" : "general";
    const attach = ctx.attach;
    const doc = await extractDocument(abs, buf, stat.size, {
      show: attach && ((f, b) => showImage(f, b, attach, purpose)),
      vision: config?.visionModel ? (f, b) => describeImage(config, f, b, ctx.signal, purpose) : undefined,
    });
    let text: string;
    let header = "";
    if (doc) {
      text = doc.text;
      header = `[${doc.summary}]`;
    } else {
      text = Buffer.from(buf).toString("utf8");
      if (stat.size > buf.length) header = `[text, ${human(stat.size)}; only the first ${human(buf.length)} is read]`;
      else ctx.files?.set(abs, hashText(text)); // a text file read whole can be edited
    }
    if (text.length === 0) return header ? `${header}\n(no text to show)` : "(empty file)";

    const lines = text.replace(/\n$/, "").split("\n");
    const start = Math.max(1, optInt(args, "offset") ?? 1);
    // Default page size follows the context budget (200 lines at 32k characters).
    const limit = optInt(args, "limit") ?? (ctx.config ? Math.min(500, Math.max(100, Math.floor(ctx.config.maxContextChars / 160))) : 500);
    if (start > lines.length) throw new Error(`${shown} has only ${lines.length} lines; offset ${start} is past the end.`);
    // The page also ends on a whole line before the agent's cap on a tool result, which would cut
    // the middle out (seen live: a site map kept only its first and last 3,200 characters).
    const budget = toolOutputLimit(ctx.config?.maxContextChars ?? 100_000) - header.length - (doc ? OUTLINE_RESERVE : 100);
    const numbered: string[] = [];
    let used = 0;
    for (let i = start - 1; i < lines.length && numbered.length < limit; i++) {
      const l = lines[i];
      const row = `${String(i + 1).padStart(6)}\t${l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}… [line truncated]` : l}`;
      if (numbered.length && used + row.length + 1 > budget) break;
      numbered.push(row);
      used += row.length + 1;
    }
    const end = start - 1 + numbered.length;
    let more = end < lines.length ? `\n[${lines.length} lines total; continue with offset=${end + 1}]` : "";
    if (doc && end < lines.length) more += outline(lines, end);
    return `${header ? `${header}\n` : ""}${numbered.join("\n")}${more}`;
  },
};

const OUTLINE_RESERVE = 1_000;

/**
 * "[Headings further on: 160 MY PROFILE · 429 READINESS (chargeable)]": where to page to in a
 * long document. Headings are short lines in capitals, or Markdown headings.
 */
function outline(lines: string[], after: number): string {
  const found: string[] = [];
  let size = 0;
  for (let i = after; i < lines.length; i++) {
    const l = lines[i].trim();
    const heading = l.length >= 3 && l.length <= 70 && (/^#{1,6}\s/.test(l) || (/[A-Z].*[A-Z].*[A-Z]/.test(l) && !/[a-z]{2}/.test(l.replace(/\([^)]*\)/g, ""))));
    if (!heading) continue;
    const entry = `${i + 1} ${l.replace(/^#+\s*/, "")}`;
    if (size + entry.length + 3 > OUTLINE_RESERVE - 40) {
      found.push("…");
      break;
    }
    found.push(entry);
    size += entry.length + 3;
  }
  return found.length ? `\n[Headings further on: ${found.join(" · ")}]` : "";
}

async function readStart(file: string, bytes: number): Promise<Buffer> {
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
