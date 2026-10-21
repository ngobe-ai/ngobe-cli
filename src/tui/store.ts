import type { Mode } from "../config.js";
import type { Todo, ToolView } from "../types.js";
import { runDoneLine, type Activity, type InputRequest, type RunSummary, type SelectAnswer, type SelectRequest } from "../ui.js";

export type EntryKind = "user" | "assistant" | "tool" | "note" | "done";
export type NoteTone = "info" | "warn" | "error";

export interface Entry {
  id: number;
  kind: EntryKind;
  text: string;
  tone?: NoteTone;
  /** kind "tool": replaced (not mutated) on every update, so memoized rows can compare by reference. */
  view?: ToolView;
}

export interface ConfirmRequest {
  prompt: string;
  resolve: (answer: string) => void;
}

export interface TrustRequest {
  dir: string;
  /** 0 = yes, 1 = no */
  choice: number;
  resolve: (ok: boolean) => void;
}

export interface SelectState {
  req: SelectRequest;
  cursor: number;
  /** Multi-select: the checked values. */
  checked: Set<string>;
  resolve: (answer: SelectAnswer | null) => void;
}

export interface InputState {
  req: InputRequest;
  resolve: (text: string | null) => void;
}

let nextId = 1;

/**
 * Mutable chat state. The Tui class (Ui implementation) writes here; App.tsx
 * renders it via useSyncExternalStore on `version`. Stream writes are throttled
 * so a fast model doesn't trigger a React render per chunk.
 */
export class Store {
  entries: Entry[] = [];
  /** Entry currently receiving streamed assistant text. */
  stream: Entry | null = null;
  /** What the agent is doing (the spinner line); null when idle. */
  activity: Activity | null = null;
  todos: Todo[] = [];
  confirm: ConfirmRequest | null = null;
  trust: TrustRequest | null = null;
  /** An open menu (/agents, /model): the arrow keys move in it. */
  select: SelectState | null = null;
  /** A question answered in the prompt box: enter gives it the text instead of sending a request. */
  input: InputState | null = null;
  /** Shown in the header; /model changes it. */
  model = "";
  history: string[] = [];
  exitRequested = false;
  version = 0;

  private listeners = new Set<() => void>();
  private askWaiter: ((line: string) => void) | null = null;
  private queued: string[] = [];
  private tools = new Map<string, Entry>();
  private lastEmit = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private static readonly throttleMs = 40;

  constructor(public mode: Mode = "edit") {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private notify(immediate = false) {
    this.version++;
    const elapsed = Date.now() - this.lastEmit;
    if (immediate || elapsed >= Store.throttleMs) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.lastEmit = Date.now();
      for (const fn of this.listeners) fn();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.lastEmit = Date.now();
        for (const fn of this.listeners) fn();
      }, Store.throttleMs - elapsed);
    }
  }

  // --- entries ------------------------------------------------------------

  submit(text: string) {
    this.pushHistory(text);
    const waiter = this.askWaiter;
    if (waiter) {
      this.askWaiter = null;
      this.start(text);
      waiter(text);
    } else {
      this.queued.push(text); // type-ahead while the agent is busy; shown once ask() takes it
      this.notify(true);
    }
  }

  ask(): Promise<string> {
    const queued = this.queued.shift();
    if (queued !== undefined) {
      this.start(queued);
      return Promise.resolve(queued);
    }
    this.notify(true);
    return new Promise((resolve) => {
      this.askWaiter = resolve;
    });
  }

  get queuedCount() {
    return this.queued.length;
  }

  get busy() {
    return this.activity !== null;
  }

  /** Show a request in the transcript as the agent starts on it. */
  private start(text: string) {
    this.finalize();
    this.tools.clear();
    this.entries.push({ id: nextId++, kind: "user", text });
    this.notify(true);
  }

  write(chunk: string) {
    if (!this.stream) {
      this.stream = { id: nextId++, kind: "assistant", text: "" };
      this.entries.push(this.stream);
    }
    this.stream.text += chunk;
    this.notify();
  }

  endTurn() {
    this.finalize();
  }

  /** Close the streamed entry (trim the trailing "\n" the agent appends). */
  private finalize() {
    if (!this.stream) return;
    this.stream.text = this.stream.text.replace(/\n+$/, "");
    if (!this.stream.text.trim()) this.entries.splice(this.entries.indexOf(this.stream), 1);
    this.stream = null;
    this.notify(true);
  }

  /** A tool call appears when it starts and is updated in place when it finishes. */
  toolUpdate(view: ToolView) {
    this.finalize();
    const entry = this.tools.get(view.id);
    if (entry) entry.view = { ...view };
    else {
      const created: Entry = { id: nextId++, kind: "tool", text: "", view: { ...view } };
      this.tools.set(view.id, created);
      this.entries.push(created);
    }
    this.notify(true);
  }

  setActivity(a: Activity | null) {
    const changed = (a?.label ?? null) !== (this.activity?.label ?? null);
    this.activity = a && { ...a };
    this.notify(changed);
  }

  setTodos(list: Todo[]) {
    this.todos = list.map((t) => ({ ...t }));
    this.notify(true);
  }

  setMode(mode: Mode) {
    this.mode = mode;
    this.notify(true);
  }

  setModel(model: string) {
    this.model = model;
    this.notify(true);
  }

  // --- folder trust ------------------------------------------------------------

  requestTrust(dir: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.trust = {
        dir,
        choice: 0,
        resolve: (ok) => {
          this.trust = null;
          this.notify(true);
          resolve(ok);
        },
      };
      this.notify(true);
    });
  }

  moveTrustChoice(choice: number) {
    if (!this.trust) return;
    this.trust.choice = Math.max(0, Math.min(1, choice));
    this.notify(true);
  }

  answerTrust(ok: boolean) {
    this.trust?.resolve(ok);
  }

  // --- menus and questions (/agents, /model) -------------------------------------

  requestSelect(req: SelectRequest): Promise<SelectAnswer | null> {
    this.finalize();
    return new Promise((resolve) => {
      const initial = Math.max(0, Math.min(req.options.length - 1, req.initial ?? 0));
      this.select = {
        req,
        cursor: initial,
        checked: new Set(req.options.filter((o) => o.checked).map((o) => o.value)),
        resolve: (answer) => {
          this.select = null;
          this.notify(true);
          resolve(answer);
        },
      };
      this.notify(true);
    });
  }

  moveSelect(delta: number) {
    if (!this.select) return;
    const n = this.select.req.options.length;
    this.select.cursor = (this.select.cursor + delta + n) % n;
    this.notify(true);
  }

  /** Multi-select: check or uncheck the option under the cursor. */
  toggleSelect() {
    const s = this.select;
    if (!s?.req.multi) return;
    const value = s.req.options[s.cursor]?.value;
    if (value === undefined) return;
    if (s.checked.has(value)) s.checked.delete(value);
    else s.checked.add(value);
    this.notify(true);
  }

  /** Enter (or the alt key): the option under the cursor, or the checked ones. */
  answerSelect(alt = false) {
    const s = this.select;
    if (!s) return;
    const values = s.req.multi ? s.req.options.filter((o) => s.checked.has(o.value)).map((o) => o.value) : [s.req.options[s.cursor]?.value].filter((v): v is string => v !== undefined);
    s.resolve({ values, alt });
  }

  cancelSelect() {
    this.select?.resolve(null);
  }

  requestInput(req: InputRequest): Promise<string | null> {
    this.finalize();
    return new Promise((resolve) => {
      this.input = {
        req,
        resolve: (text) => {
          this.input = null;
          this.notify(true);
          resolve(text);
        },
      };
      this.notify(true);
    });
  }

  answerInput(text: string | null) {
    this.input?.resolve(text);
  }

  runDone(summary: RunSummary) {
    this.finalize();
    this.entries.push({ id: nextId++, kind: "done", text: runDoneLine(summary), tone: summary.outcome === "completed" ? "info" : "warn" });
    // A finished list stays visible until the next run; an all-done one is cleared.
    if (this.todos.every((t) => t.status === "completed")) this.todos = [];
    this.notify(true);
  }

  note(tone: NoteTone, text: string) {
    this.finalize();
    this.entries.push({ id: nextId++, kind: "note", text, tone });
    this.notify(true);
  }

  clear() {
    this.entries = [];
    this.tools.clear();
    this.todos = [];
    this.notify(true);
  }

  // --- permission prompts ---------------------------------------------------

  requestConfirm(prompt: string): Promise<string> {
    this.finalize();
    return new Promise<string>((resolve) => {
      this.confirm = {
        prompt,
        resolve: (answer) => {
          this.confirm = null;
          const question = prompt.split("\n")[0];
          this.entries.push({ id: nextId++, kind: "note", text: `${question} → ${answer || "n"}`, tone: "info" });
          this.notify(true);
          resolve(answer);
        },
      };
      this.notify(true);
    });
  }

  answerConfirm(answer: string) {
    this.confirm?.resolve(answer);
  }

  /** Resolve a pending confirm as "n" (used when the run is aborted). */
  cancelConfirm() {
    if (this.confirm) this.answerConfirm("n");
  }

  // --- history / lifecycle ---------------------------------------------------

  private pushHistory(text: string) {
    if (text && this.history[this.history.length - 1] !== text) this.history.push(text);
    if (this.history.length > 1000) this.history.shift();
  }

  requestExit() {
    this.exitRequested = true;
    this.notify(true);
  }
}
