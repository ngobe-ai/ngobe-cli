import {render} from "ink";
import {Store} from "./store.js";
import {App, type TuiConfig} from "./App.js";
import type {Mode} from "../config.js";
import type {Todo, ToolView} from "../types.js";
import type {Activity, RunSummary, Ui} from "../ui.js";

export type {TuiConfig};

/** Chat-screen terminal UI (ink). Implements the Ui interface the agent talks to. */
export class Tui implements Ui {
  private store: Store;
  private userInterrupt: () => boolean = () => false;
  private modeCycle: () => void = () => {};
  private instance: ReturnType<typeof render>;

  constructor(config: TuiConfig) {
    this.store = new Store(config.mode);
    this.store.model = config.model;
    this.instance = render(
      <App
        store={this.store}
        config={config}
        onInterrupt={() => {
          const handled = this.userInterrupt();
          if (handled) this.store.cancelConfirm(); // don't leave a dead y/n prompt open
          return handled;
        }}
        onModeCycle={() => this.modeCycle()}
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
  toolUpdate(view: ToolView): void {
    this.store.toolUpdate(view);
  }
  activity(a: Activity | null): void {
    this.store.setActivity(a);
  }
  todos(list: Todo[]): void {
    this.store.setTodos(list);
  }
  runDone(summary: RunSummary): void {
    this.store.runDone(summary);
  }
  modeChanged(mode: Mode): void {
    this.store.setMode(mode);
  }
  clear(): void {
    this.store.clear();
  }
  modelChanged(model: string): void {
    this.store.setModel(model);
  }
  onModeCycle(cb: () => void): void {
    this.modeCycle = cb;
  }
  trust(dir: string): Promise<boolean> {
    return this.store.requestTrust(dir);
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
