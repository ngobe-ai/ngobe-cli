import type { Mode } from "./config.js";
import type { Todo, ToolView } from "./types.js";

const paint = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;

/**
 * Model-supplied text made safe to show in a prompt: terminal escape sequences removed and
 * other control characters (\r, backspace …) made visible, so nothing can be hidden from the
 * person approving it. Newlines and tabs are kept.
 */
export function printable(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}
export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);

/** What the agent is doing right now, for the status line. */
export interface Activity {
  /** "Thinking", "Reading src/a.ts", "Running tests" … */
  label: string;
  /** When the current run started (the status line shows the elapsed time). */
  since: number;
  /** Tokens used so far in this run (estimated while streaming). */
  tokens: number;
}

export interface RunSummary {
  outcome: string;
  ms: number;
  tokens: number;
  toolCalls: number;
}

/** "1m 05s", "8.2s" */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** "950", "3.1k" */
export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/** "Done in 1m 05s · 3.1k tokens · 4 tool calls" */
export function runDoneLine(s: RunSummary): string {
  const verb = s.outcome === "completed" ? "Done in" : s.outcome === "cancelled" ? "Interrupted after" : s.outcome === "declined" ? "Paused after" : "Stopped after";
  const calls = s.toolCalls ? ` · ${s.toolCalls} tool call${s.toolCalls === 1 ? "" : "s"}` : "";
  return `${verb} ${formatDuration(s.ms)} · ${formatTokens(s.tokens)} tokens${calls}`;
}

/**
 * Everything the agent needs from the terminal. Two implementations:
 * LineUi (plain scrolling output, one-shot mode) and the ink TUI in src/tui (REPL mode).
 * onInterrupt fires on Ctrl+C (or Esc in the TUI); the callback returns true if it handled the
 * signal (e.g. aborted a run) and false if the UI should exit.
 */
export interface Ui {
  /** Read one user request. */
  ask(): Promise<string>;
  /** Ask a y/n-style question; resolves with the raw answer. */
  confirm(prompt: string): Promise<string>;
  /** Stream a chunk of the assistant's reply. */
  write(chunk: string): void;
  /** Called when the model stops streaming (before any tool runs or the turn ends). */
  endTurn(): void;
  info(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  /** A tool call starts (state "running") or finishes (same id, final state). */
  toolUpdate(view: ToolView): void;
  /** The status line; null when the agent is idle. */
  activity(a: Activity | null): void;
  /** The agent's task list changed. */
  todos(list: Todo[]): void;
  /** A run finished. */
  runDone(summary: RunSummary): void;
  /** The permission mode changed (an approved plan). */
  modeChanged?(mode: Mode): void;
  /** /clear: empty the transcript. */
  clear?(): void;
  /** /model switched the model. */
  modelChanged?(model: string): void;
  /** The user asks to cycle the mode (shift+tab); the callback switches it. */
  onModeCycle?(cb: () => void): void;
  /** First run in a folder: does the user trust it? Resolves false to quit. */
  trust?(dir: string): Promise<boolean>;
  onInterrupt(cb: () => boolean): void;
  close(): void | Promise<void>;
}
