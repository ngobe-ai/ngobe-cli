import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Args, Tool, ToolContext } from "../types.js";
import { optInt, reqStr, isSecretPath, resolveInside } from "./util.js";
import { assertPatternInside, findFiles } from "./glob.js";

const MAX_LINES = 150;
// Secret files ripgrep would otherwise search (dotfiles like .env are already skipped as hidden).
const RG_SECRET_EXCLUDES = ["*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.kdbx", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json"];
// ripgrep's --type names for common languages, with the extensions the JS fallback uses.
const TYPES: Record<string, string[]> = {
  ts: ["ts", "tsx", "mts", "cts"],
  js: ["js", "jsx", "mjs", "cjs"],
  py: ["py"],
  go: ["go"],
  rust: ["rs"],
  java: ["java"],
  kotlin: ["kt", "kts"],
  dart: ["dart"],
  php: ["php"],
  ruby: ["rb"],
  swift: ["swift"],
  c: ["c", "h"],
  cpp: ["cc", "cpp", "cxx", "hpp", "hh", "h"],
  cs: ["cs"],
  css: ["css", "scss", "sass", "less"],
  html: ["html", "htm"],
  json: ["json"],
  yaml: ["yaml", "yml"],
  md: ["md", "markdown"],
  sql: ["sql"],
  sh: ["sh", "bash", "zsh"],
};

type Mode = "content" | "files_with_matches" | "count";

interface Query {
  re: RegExp;
  pattern: string;
  mode: Mode;
  dir: string; // absolute
  glob: string;
  type?: string;
  ignoreCase: boolean;
  context: number;
  limit: number;
}

export const grep: Tool = {
  name: "grep",
  label: "Grep",
  description:
    'Search file contents with a regular expression (ripgrep syntax). output_mode "content" (default) gives path:line:text, "files_with_matches" only file paths, "count" matches per file. Narrow with path, glob ("*.ts") or type ("py"). Skips .gitignored, hidden and secret files.',
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression" },
      path: { type: "string", description: "File or directory to search (default: the project root)" },
      glob: { type: "string", description: 'Only files matching this glob, e.g. "*.ts" or "src/**/*.py"' },
      type: { type: "string", description: `File type: ${Object.keys(TYPES).join(", ")}` },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
      case_insensitive: { type: "boolean" },
      context: { type: "integer", minimum: 0, maximum: 10, description: "Lines of context around each match (content mode)" },
      head_limit: { type: "integer", minimum: 1, description: `Max result lines (default ${MAX_LINES})` },
    },
    required: ["pattern"],
  },
  lean: {
    description: "Search file contents with a regex. Returns path:line:text.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, glob: { type: "string" }, case_insensitive: { type: "boolean" } },
      required: ["pattern"],
    },
  },
  aliases: { "-i": "case_insensitive", "-C": "context" },
  risk: "safe",
  describe: (a) => `grep /${a.pattern}/${a.glob ? " in " + a.glob : ""}`,
  target: (a) => `${a.pattern}${a.path ? ` in ${a.path}` : a.glob ? ` in ${a.glob}` : ""}`,
  activity: (a) => `Searching for ${a.pattern}`,
  summarize(a, output) {
    if (output.startsWith("No matches")) return { summary: "No matches" };
    const lines = output.split("\n").filter((l) => l && !l.startsWith("["));
    if (a.output_mode === "files_with_matches") return { summary: `Found ${lines.length} file${lines.length === 1 ? "" : "s"}` };
    if (a.output_mode === "count") return { summary: `Matches in ${lines.length} file${lines.length === 1 ? "" : "s"}` };
    const hits = lines.filter((l) => /^[^:]+:\d+:/.test(l));
    const files = new Set(hits.map((l) => l.slice(0, l.indexOf(":")))).size;
    return { summary: `${hits.length} match${hits.length === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}` };
  },
  async run(args, ctx) {
    const q = query(args, ctx);
    const lines = (hasRipgrep() && (await ripgrep(q, ctx))) || (await jsGrep(q, ctx));
    if (lines.length === 0) return "No matches.";
    return lines.join("\n") + (lines.length >= q.limit ? `\n[result limit (${q.limit}) reached; narrow the search or raise head_limit]` : "");
  },
};

function query(args: Args, ctx: ToolContext): Query {
  const pattern = reqStr(args, "pattern");
  const ignoreCase = args.case_insensitive === true;
  const re = new RegExp(pattern, ignoreCase ? "i" : ""); // invalid patterns go back to the model as an error
  const glob = typeof args.glob === "string" && args.glob ? args.glob : "**/*";
  assertPatternInside(glob, ctx.cwd);
  const type = typeof args.type === "string" && args.type ? args.type : undefined;
  if (type && !TYPES[type]) throw new Error(`unknown type "${type}"; use one of ${Object.keys(TYPES).join(", ")}`);
  const dir = resolveInside(ctx.cwd, typeof args.path === "string" && args.path ? args.path : ".");
  const mode = (args.output_mode as Mode) ?? "content";
  // Default result size follows the context budget: every line is re-read on each later turn.
  const budget = ctx.config ? Math.min(MAX_LINES, Math.max(30, Math.floor(ctx.config.maxContextChars / 400))) : MAX_LINES;
  return { re, pattern, mode, dir, glob, type, ignoreCase, context: optInt(args, "context") ?? 0, limit: optInt(args, "head_limit") ?? budget };
}

let rgAvailable: boolean | undefined;
function hasRipgrep(): boolean {
  rgAvailable ??= spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  return rgAvailable;
}

/** ripgrep, or null when it can't handle the pattern (its regex dialect lacks lookaround and backreferences). */
function ripgrep(q: Query, ctx: ToolContext): Promise<string[] | null> {
  const args = ["--no-heading", "--with-filename", "--color", "never", "--max-columns", "300"];
  if (q.mode === "files_with_matches") args.push("--files-with-matches");
  else if (q.mode === "count") args.push("--count");
  else args.push("--line-number", ...(q.context ? ["--context", String(q.context)] : []));
  if (q.ignoreCase) args.push("--ignore-case");
  if (q.glob !== "**/*") args.push("-g", q.glob);
  if (q.type) args.push("--type", q.type);
  for (const g of RG_SECRET_EXCLUDES) args.push("-g", `!${g}`);
  const target = path.relative(ctx.cwd, q.dir) || ".";
  args.push("-e", q.pattern, "--", target);

  return new Promise((resolve) => {
    const child = spawn("rg", args, { cwd: ctx.cwd, signal: ctx.signal, stdio: ["ignore", "pipe", "ignore"] });
    const out: string[] = [];
    let buffer = "";
    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const hit = line.replace(/^\.\//, "");
        if (hit === "--") {
          out.push("--");
          continue;
        }
        if (isSecretPath(hit.split(/[:-]\d+[:-]|:/)[0])) continue;
        out.push(trimHit(hit));
        if (out.length >= q.limit) {
          child.kill();
          break;
        }
      }
    });
    child.on("error", () => resolve(null));
    // 0 = matches, 1 = none, 2 = error (bad regex, unreadable file); with results, an unreadable file doesn't matter.
    child.on("close", (code) => resolve(code === 2 && out.length === 0 ? null : out));
  });
}

async function jsGrep(q: Query, ctx: ToolContext): Promise<string[]> {
  const stat = await fs.stat(q.dir).catch(() => null);
  const rel = path.relative(ctx.cwd, q.dir);
  let files = stat?.isFile() ? [rel] : (await findFiles(q.glob, q.dir)).map((f) => path.join(rel, f));
  if (q.type) files = files.filter((f) => TYPES[q.type!].includes(path.extname(f).slice(1)));
  const out: string[] = [];
  for (const file of files.sort()) {
    if (out.length >= q.limit) break;
    if (isSecretPath(file)) continue;
    const abs = path.join(ctx.cwd, file);
    let text: string;
    try {
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink() || st.size > 1_000_000) continue; // links may point outside the project
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue; // binary
    const lines = text.split("\n");
    // Only the start of very long lines (minified code) is searched, which also bounds a slow regex.
    const matches = lines.map((l, i) => (q.re.test(l.length > 2000 ? l.slice(0, 2000) : l) ? i : -1)).filter((i) => i >= 0);
    if (matches.length === 0) continue;
    if (q.mode === "files_with_matches") out.push(file);
    else if (q.mode === "count") out.push(`${file}:${matches.length}`);
    else {
      const shown = new Set<number>();
      for (const m of matches) for (let i = Math.max(0, m - q.context); i <= Math.min(lines.length - 1, m + q.context); i++) shown.add(i);
      let last = -2;
      for (const i of [...shown].sort((a, b) => a - b)) {
        if (out.length >= q.limit) break;
        if (q.context && last >= 0 && i > last + 1) out.push("--");
        out.push(trimHit(`${file}${matches.includes(i) ? ":" : "-"}${i + 1}${matches.includes(i) ? ":" : "-"}${lines[i]}`));
        last = i;
      }
    }
  }
  return out.slice(0, q.limit);
}

/** Keep path:line plus the first 200 characters of the matched line. */
function trimHit(hit: string): string {
  const m = /^([^:]*[:-]\d+[:-])(.*)$/.exec(hit);
  return m ? m[1] + m[2].slice(0, 200) : hit.slice(0, 300);
}
