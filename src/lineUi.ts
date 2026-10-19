import * as readline from "node:readline/promises";
import { bold, cyan, dim, red, yellow, type Ui } from "./ui.js";

/** Plain scrolling terminal I/O, used in one-shot mode where there is no REPL. */
export class LineUi implements Ui {
  private rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  async ask(): Promise<string> {
    return this.rl.question(bold(cyan("❯ ")));
  }
  confirm(prompt: string): Promise<string> {
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
    this.rl.close();
  }
  private wrote = false;

  write(text: string) {
    process.stdout.write(text);
    if (text) this.wrote = true;
  }
  endTurn() {
    if (this.wrote) process.stdout.write("\n");
    this.wrote = false;
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
