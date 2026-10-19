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

/**
 * Everything the agent needs from the terminal. Two implementations:
 * LineUi (plain scrolling output, one-shot mode) and the ink TUI in src/tui (REPL mode).
 * onInterrupt fires on Ctrl+C; the callback returns true if it handled the signal
 * (e.g. aborted a run) and false if the UI should exit.
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
  /** Show that a tool is about to run. */
  tool(summary: string): void;
  onInterrupt(cb: () => boolean): void;
  close(): void | Promise<void>;
}
