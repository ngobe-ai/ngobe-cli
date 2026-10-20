import * as readline from "node:readline/promises";
import chalk from "chalk";
import { highlight } from "./diff.js";
import { mdLine, type MdState } from "./markdown.js";
import type { PreviewLine, Todo, ToolView } from "./types.js";
import { bold, cyan, dim, formatDuration, formatTokens, green, red, runDoneLine, yellow, type Activity, type RunSummary, type Ui } from "./ui.js";

const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const PREVIEW_LINES = 8;

const TONE: Record<NonNullable<PreviewLine["tone"]>, (s: string) => string> = { add: green, remove: red, context: (s) => s, dim, error: red };
const DIFF_LINES = 30;
const DOT: Record<ToolView["state"], (s: string) => string> = { running: dim, ok: green, error: red, declined: yellow };

/** "⏺ Read(src/a.ts)" and its "⎿ summary" / preview lines, as printed when the call finishes. */
export function toolLines(v: ToolView, width = 100): string[] {
  const head = `${DOT[v.state]("⏺")} ${bold(v.label)}${v.target ? dim(`(${clip(v.target, width - v.label.length - 6)})`) : ""}`;
  const lines = [head];
  if (v.summary) lines.push(`  ${dim("⎿")}  ${v.state === "error" ? red(v.summary) : v.state === "declined" ? yellow(v.summary) : dim(v.summary)}`);
  const preview = v.preview ?? [];
  if (preview.some((p) => p.line !== undefined)) return [...lines, ...diffLines(preview, width)];
  for (const p of preview.slice(0, PREVIEW_LINES)) lines.push(`     ${p.tone ? TONE[p.tone](clip(p.text, width - 5)) : clip(p.text, width - 5)}`);
  if (preview.length > PREVIEW_LINES) lines.push(`     ${dim(`… +${preview.length - PREVIEW_LINES} lines`)}`);
  return lines;
}

/** Diff rows like Claude Code's: numbered, "-" on red and "+" on green across the row, code colored. */
function diffLines(preview: PreviewLine[], width: number): string[] {
  const shown = preview.slice(0, DIFF_LINES);
  const w = Math.max(...shown.map((p) => String(p.line ?? "").length));
  const out = shown.map((p) => {
    if (p.line === undefined) return `     ${" ".repeat(w)}   ${dim(p.text)}`;
    const mark = p.tone === "add" ? green("+") : p.tone === "remove" ? red("-") : " ";
    const code = clip(p.text, width - w - 9);
    const row = `${dim(String(p.line).padStart(w))} ${mark} ${highlight(code, p.lang).map((s) => (s.color ? chalk.hex(s.color.startsWith("#") ? s.color : "#7f849c")(s.text) : s.text)).join("")}`;
    const pad = " ".repeat(Math.max(0, width - 5 - (w + 3 + code.length)));
    return `     ${p.tone === "add" ? chalk.bgHex("#12361d")(row + pad) : p.tone === "remove" ? chalk.bgHex("#3d1418")(row + pad) : row}`;
  });
  if (preview.length > DIFF_LINES) out.push(`     ${dim(`… +${preview.length - DIFF_LINES} lines`)}`);
  return out;
}

/** "✻ Running tests… (34s · 2.8k tokens · ctrl+c to interrupt)" */
export function activityLine(a: Activity, frame: number, now = Date.now(), key = "ctrl+c"): string {
  const stats = [formatDuration(now - a.since), a.tokens ? `${formatTokens(a.tokens)} tokens` : "", `${key} to interrupt`].filter(Boolean).join(" · ");
  return `${cyan(SPINNER[frame % SPINNER.length])} ${cyan(`${a.label}…`)} ${dim(`(${stats})`)}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s;
}

/** Plain scrolling terminal I/O, used in one-shot mode where there is no REPL. */
export class LineUi implements Ui {
  private rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  private tty = process.stdout.isTTY === true;
  private wrote = false;
  private current: Activity | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private spinnerShown = false;
  /** Streamed text not yet printed: a reply is rendered as markdown one full line at a time. */
  private pending = "";
  private md: MdState = { fenced: false };

  /** canConfirm is false when stdin isn't a terminal: piped lines are requests, not y/n answers. */
  constructor(private canConfirm = process.stdin.isTTY === true) {}

  async ask(): Promise<string> {
    return this.rl.question(bold(cyan("❯ ")));
  }
  confirm(prompt: string): Promise<string> {
    this.clearSpinner();
    if (!this.canConfirm) {
      console.log(yellow(`  ${prompt} denied: no terminal to ask (use --yolo to allow)`));
      return Promise.resolve("n");
    }
    return this.rl.question(`  ${prompt} [y/n/a] `);
  }
  onInterrupt(cb: () => boolean) {
    this.rl.on("SIGINT", () => {
      if (!cb()) {
        this.close();
        process.exit(0);
      }
    });
  }
  close() {
    this.activity(null);
    this.rl.close();
  }

  write(text: string) {
    if (!text) return;
    if (!this.tty) {
      // Piped output stays plain text, exactly as the model wrote it.
      process.stdout.write(text);
      this.wrote = true;
      return;
    }
    this.pending += text;
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.emit(line);
  }
  endTurn() {
    if (this.pending) this.emit(this.pending);
    this.pending = "";
    this.md = { fenced: false };
    if (this.wrote) process.stdout.write("\n");
    this.wrote = false;
  }
  private emit(line: string) {
    const shown = mdLine(line, this.md);
    if (shown === null) return;
    this.clearSpinner();
    process.stdout.write(`${shown}\n`);
  }
  info(text: string) {
    this.print(dim(text));
  }
  warn(text: string) {
    this.print(yellow(text));
  }
  error(text: string) {
    this.print(red(text));
  }
  toolUpdate(view: ToolView) {
    // Printed once, when finished: parallel calls would otherwise interleave their lines.
    if (view.state === "running") return;
    // A blank line before each call, as in the chat screen.
    this.print(`${this.tty ? "\n" : ""}${toolLines(view, process.stdout.columns || 100).join("\n")}`);
  }
  todos(_list: Todo[]) {
    // todo_write's own result already shows the list.
  }
  runDone(summary: RunSummary) {
    if (this.tty) this.print(dim(`✻ ${runDoneLine(summary)}`));
  }

  /** The spinner line is drawn only between outputs, never in the middle of streamed text. */
  activity(a: Activity | null) {
    this.current = a;
    if (!this.tty) return;
    if (!a) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.clearSpinner();
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => this.drawSpinner(), 120);
      this.timer.unref?.();
    }
  }

  private drawSpinner() {
    if (!this.current || this.wrote) return;
    const line = activityLine(this.current, this.frame++);
    process.stdout.write(`\r\x1b[2K${line}`);
    this.spinnerShown = true;
  }
  private clearSpinner() {
    if (!this.spinnerShown) return;
    process.stdout.write("\r\x1b[2K");
    this.spinnerShown = false;
  }
  private print(text: string) {
    if (this.pending) {
      this.emit(this.pending);
      this.pending = "";
    }
    this.clearSpinner();
    if (this.wrote) {
      process.stdout.write("\n");
      this.wrote = false;
    }
    console.log(text);
  }
}
