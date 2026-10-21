import os from "node:os";
import path from "node:path";
import {render} from "ink";
import {saveClipboardImage} from "../clipboard.js";
import {Store} from "./store.js";
import {App, type TuiConfig} from "./App.js";
import type {Mode} from "../config.js";
import type {Todo, ToolView} from "../types.js";
import type {Activity, InputRequest, RunSummary, SelectAnswer, SelectRequest, Ui} from "../ui.js";

export type {TuiConfig};

const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";

/** Chat-screen terminal UI (ink). Implements the Ui interface the agent talks to. */
export class Tui implements Ui {
  private store: Store;
  private userInterrupt: () => boolean = () => false;
  private modeCycle: () => void = () => {};
  private typing: () => void = () => {};
  private lastTyping = 0;
  private instance: ReturnType<typeof render>;

  constructor(config: TuiConfig) {
    this.store = new Store(config.mode);
    this.store.model = config.model;
    // Like full-screen terminal apps: the alternate screen has no scrollback for frames to pile up
    // in, and the wheel is reported to us (SGR mode) so only the conversation scrolls. Text
    // selection then needs Option (macOS) or Shift held; NGOBE_MOUSE=0 leaves the mouse alone.
    if (config.mouse !== false) {
      process.stdout.write(MOUSE_ON);
      process.once("exit", () => process.stdout.write(MOUSE_OFF));
    }
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
        onPasteImage={() => saveClipboardImage(path.join(config.stateDir ?? os.tmpdir(), "clipboard"))}
        onTyping={() => {
          if (Date.now() - this.lastTyping < 5_000) return;
          this.lastTyping = Date.now();
          this.typing();
        }}
      />,
      {exitOnCtrlC: false, alternateScreen: true}, // Ctrl+C is routed through onInterrupt instead
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
  onTyping(cb: () => void): void {
    this.typing = cb;
  }
  trust(dir: string): Promise<boolean> {
    return this.store.requestTrust(dir);
  }
  select(req: SelectRequest): Promise<SelectAnswer | null> {
    return this.store.requestSelect(req);
  }
  input(req: InputRequest): Promise<string | null> {
    return this.store.requestInput(req);
  }
  onInterrupt(cb: () => boolean): void {
    this.userInterrupt = cb;
  }
  async close(): Promise<void> {
    this.store.endTurn();
    this.store.requestExit();
    await this.instance.waitUntilExit();
    process.stdout.write(MOUSE_OFF);
  }
}
