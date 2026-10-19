import {render} from "ink";
import {Store} from "./store.js";
import {App, type TuiConfig} from "./App.js";
import type {Ui} from "../ui.js";

export type {TuiConfig};

/** Chat-screen terminal UI (ink). Implements the Ui interface the agent talks to. */
export class Tui implements Ui {
  private store = new Store();
  private userInterrupt: () => boolean = () => false;
  private instance: ReturnType<typeof render>;

  constructor(config: TuiConfig) {
    this.instance = render(
      <App
        store={this.store}
        config={config}
        onInterrupt={() => {
          const handled = this.userInterrupt();
          if (handled) this.store.cancelConfirm(); // don't leave a dead y/n prompt open
          return handled;
        }}
      />,
      {exitOnCtrlC: false}, // Ctrl+C is routed through onInterrupt instead
    );
  }

  ask(): Promise<string> {
    return this.store.ask();
  }
  confirm(prompt: string): Promise<string> {
    return this.store.requestConfirm(prompt);
  }
  write(chunk: string): void {
    this.store.write(chunk);
  }
  endTurn(): void {
    this.store.endTurn();
  }
  info(text: string): void {
    this.store.note("info", text);
  }
  warn(text: string): void {
    this.store.note("warn", text);
  }
  error(text: string): void {
    this.store.note("error", text);
  }
  tool(summary: string): void {
    this.store.tool(summary);
  }
  onInterrupt(cb: () => boolean): void {
    this.userInterrupt = cb;
  }
  async close(): Promise<void> {
    this.store.endTurn();
    this.store.requestExit();
    await this.instance.waitUntilExit();
  }
}
