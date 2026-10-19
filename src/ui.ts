import * as readline from "node:readline/promises";

const paint = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const yellow = paint(33);
export const cyan = paint(36);

/** All terminal I/O goes through here so it can later be swapped for a TUI (ink, etc). */
export class UI {
  private rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 1000,
    removeHistoryDuplicates: true,
  });
  // rl.question() drops lines that arrive while no question is pending (pipes, pastes),
  // so input goes through a permanent listener + queue instead.
  private queue: string[] = [];
  private waiters: Array<(line: string | null) => void> = [];
  private closed = false;

  constructor() {
    this.rl.on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.queue.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
  }

  /**
   * Read one request. A trailing backslash continues onto the next line,
   * so multi-line instructions and code blocks can be written piece by piece.
   */
  async ask(): Promise<string> {
    let text = await this.readLine(bold(cyan("❯ ")));
    while (text.endsWith("\\")) {
      const next = await this.readLine(dim("  … "));
      text = `${text.slice(0, -1)}\n${next}`;
    }
    return text;
  }

  /** Short inline question (permission prompts); no history, no continuation. */
  async confirm(prompt: string): Promise<string> {
    return (await this.readLine(prompt)) ?? "";
  }
  onInterrupt(cb: () => void) {
    this.rl.on("SIGINT", cb);
  }
  close() {
    this.rl.close();
  }

  /** Show the prompt and wait for the next input line; throws once input is closed. */
  private readLine(prompt: string): Promise<string> {
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return this.nextLine().then((line) => {
      if (line === null) throw new Error("input closed");
      return line;
    });
  }

  private nextLine(): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  write(text: string) {
    process.stdout.write(text);
  }
  info(text: string) {
    console.log(dim(text));
  }
  warn(text: string) {
    console.log(yellow(text));
  }
  error(text: string) {
    console.log(red(text));
  }
  tool(summary: string) {
    console.log(cyan(`\n• ${summary}`));
  }

  /** Startup screen for interactive mode. */
  banner(opts: { model: string; baseURL: string; cwd: string; yolo: boolean }) {
    const rows: Array<[string, string]> = [
      ["model", opts.model],
      ["endpoint", opts.baseURL],
      ["cwd", opts.cwd],
    ];
    if (opts.yolo) rows.push(["mode", `${yellow("yolo")} — permission prompts are skipped`]);
    const width = Math.max(...rows.map(([k]) => k.length));
    console.log(`\n${bold(cyan("mugamba"))} ${dim("· minimal coding agent")}`);
    console.log(rows.map(([k, v]) => `  ${dim(k.padEnd(width))}  ${v}`).join("\n"));
    console.log(dim("\n/help for commands · \\ continues a line · Ctrl+C interrupts a run · Ctrl+D quits"));
  }
}
