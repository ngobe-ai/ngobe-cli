import type { PreviewLine } from "./types.js";

/**
 * What an edit changed, shown like Claude Code: the changed lines with 3 lines of context, removed
 * lines numbered as they were and the rest as they are now, hunks far apart separated by "…".
 * The common start and end are trimmed first, so a small edit in a big file stays cheap; the rest
 * is an exact line diff (LCS), or "all removed, all added" past a size cap.
 */

const CONTEXT = 3;
/** Cells of the LCS table (old lines × new lines in the changed middle) before giving up on exactness. */
const MAX_CELLS = 2_000_000;

type Op = { kind: "same" | "add" | "remove"; text: string; oldNo: number; newNo: number };

export function diffPreview(before: string, after: string, lang?: string): { lines: PreviewLine[]; added: number; removed: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const ops: Op[] = [];
  for (let i = 0; i < head; i++) ops.push({ kind: "same", text: a[i], oldNo: i + 1, newNo: i + 1 });
  for (const op of middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail))) {
    ops.push({ ...op, oldNo: op.oldNo + head, newNo: op.newNo + head });
  }
  const shift = b.length - a.length;
  for (let i = a.length - tail; i < a.length; i++) ops.push({ kind: "same", text: a[i], oldNo: i + 1, newNo: i + 1 + shift });

  // Context: lines within CONTEXT of a change; gaps between kept ranges become "…".
  const changed = ops.map((o, i) => (o.kind === "same" ? -1 : i)).filter((i) => i >= 0);
  const keep = new Set<number>();
  for (const i of changed) for (let j = Math.max(0, i - CONTEXT); j <= Math.min(ops.length - 1, i + CONTEXT); j++) keep.add(j);
  const lines: PreviewLine[] = [];
  let last = -1;
  for (const i of [...keep].sort((x, y) => x - y)) {
    if (last >= 0 && i > last + 1) lines.push({ text: "…", tone: "dim" });
    const o = ops[i];
    lines.push({ text: o.text, tone: o.kind === "same" ? "context" : o.kind, line: o.kind === "remove" ? o.oldNo : o.newNo, lang });
    last = i;
  }
  return { lines, added: ops.filter((o) => o.kind === "add").length, removed: ops.filter((o) => o.kind === "remove").length };
}

/** A new file: its first lines, numbered, as additions. */
export function createdPreview(content: string, lang?: string, max = 12): PreviewLine[] {
  const all = splitLines(content);
  const shown: PreviewLine[] = all.slice(0, max).map((text, i) => ({ text, tone: "add", line: i + 1, lang }));
  if (all.length > max) shown.push({ text: `… +${all.length - max} lines`, tone: "dim" });
  return shown;
}

/** "ts" for "src/db.ts": the language hint for syntax colors. */
export function langOf(file: string): string | undefined {
  return /\.([A-Za-z0-9]+)$/.exec(file)?.[1]?.toLowerCase();
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

/** The changed middle: an exact line diff, numbered from 1 within it. */
function middle(a: string[], b: string[]): Op[] {
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text, i) => ({ kind: "remove" as const, text, oldNo: i + 1, newNo: 0 })), ...b.map((text, j) => ({ kind: "add" as const, text, oldNo: 0, newNo: j + 1 }))];
  }
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w); // lcs[i][j]: common lines of a[i..] and b[j..]
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    // On a tie, removals first: "- old" above "+ new", as diffs are read.
    if (i < n && j < m && a[i] === b[j]) ops.push({ kind: "same", text: a[i++], oldNo: i, newNo: ++j });
    else if (i < n && (j === m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) ops.push({ kind: "remove", text: a[i++], oldNo: i, newNo: j });
    else ops.push({ kind: "add", text: b[j++], oldNo: i, newNo: j });
  }
  return ops;
}

// ---------------------------------------------------------------- syntax colors

export interface Segment {
  text: string;
  color?: string;
}

const KEYWORDS = new Set(
  (
    "abstract as async await break case catch class const continue def default defer del do elif else enum export extends final finally fn for from func function " +
    "go if impl implements import in instanceof interface is lambda late let match mod module mut namespace new not of or and override package pass private " +
    "protected pub public raise readonly required return self static struct super switch this throw throws trait try type typeof use val var void where while with yield " +
    "true false null nil None True False undefined"
  ).split(" "),
);
const HASH_COMMENT = new Set(["py", "sh", "bash", "zsh", "rb", "yaml", "yml", "toml", "r", "pl", "conf", "dockerfile", "mk"]);

/** Light syntax colors for one line of code: comments, strings, keywords, numbers, function names. */
export function highlight(line: string, lang?: string): Segment[] {
  if (!lang) return [{ text: line }];
  const comment = HASH_COMMENT.has(lang) ? String.raw`#.*$` : lang === "sql" || lang === "lua" ? String.raw`--.*$` : String.raw`\/\/.*$|\/\*.*?\*\/|<!--.*?-->`;
  const re = new RegExp(String.raw`(${comment})|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|\`(?:[^\`\\]|\\.)*\`?)|\b(\d[\d_.]*[a-zA-Z]*)\b|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)`, "g");
  const out: Segment[] = [];
  let at = 0;
  for (const m of line.matchAll(re)) {
    if (m.index > at) out.push({ text: line.slice(at, m.index) });
    const [all, com, str, num, fn, word] = m;
    const color = com ? "gray" : str ? "#a6e3a1" : num ? "#fab387" : fn ? "#89b4fa" : word && KEYWORDS.has(word) ? "#cba6f7" : undefined;
    out.push(color ? { text: all, color } : { text: all });
    at = m.index + all.length;
  }
  if (at < line.length) out.push({ text: line.slice(at) });
  return out;
}
