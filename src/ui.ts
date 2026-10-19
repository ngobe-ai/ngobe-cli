import * as readline from "node:readline/promises";

const paint = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
export const dim = paint(2);
export const red = paint(31);
export const yellow = paint(33);
export const cyan = paint(36);

/** All terminal I/O goes through here so it can later be swapped for a TUI (ink, etc). */
export class UI {
  private rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  ask(prompt: string): Promise<string> {
    return this.rl.question(prompt);
  }
  onInterrupt(cb: () => void) {
    this.rl.on("SIGINT", cb);
  }
  close() {
    this.rl.close();
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
}
