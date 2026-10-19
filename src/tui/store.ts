export type EntryKind = "user" | "assistant" | "tool" | "note";
export type NoteTone = "info" | "warn" | "error";

export interface Entry {
  id: number;
  kind: EntryKind;
  text: string;
  tone?: NoteTone;
}

export interface ConfirmRequest {
  prompt: string;
  resolve: (answer: string) => void;
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
  /** Short status shown in the header while waiting for the model. */
  status = "";
  confirm: ConfirmRequest | null = null;
  history: string[] = [];
  exitRequested = false;
  version = 0;

  private listeners = new Set<() => void>();
  private askWaiter: ((line: string) => void) | null = null;
  private queued: string[] = [];
  private lastEmit = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private static readonly throttleMs = 40;

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
    this.finalize();
    this.entries.push({ id: nextId++, kind: "user", text });
    this.pushHistory(text);
    this.status = "thinking…";
    const waiter = this.askWaiter;
    if (waiter) {
      this.askWaiter = null;
      waiter(text);
    } else {
      this.queued.push(text); // type-ahead submitted while the agent was busy
    }
    this.notify(true);
  }

  ask(): Promise<string> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.askWaiter = resolve;
    });
  }

  write(chunk: string) {
    if (!this.stream) {
      this.stream = { id: nextId++, kind: "assistant", text: "" };
      this.entries.push(this.stream);
    }
    this.stream.text += chunk;
    this.status = "";
    this.notify();
  }

  endTurn() {
    this.finalize();
  }

  /** Close the streamed entry (trim the trailing "\n" the agent appends). */
  private finalize() {
    if (!this.stream) return;
    this.stream.text = this.stream.text.replace(/\n$/, "");
    this.stream = null;
    this.status = "";
    this.notify(true);
  }

  tool(summary: string) {
    this.finalize();
    this.status = "";
    this.entries.push({ id: nextId++, kind: "tool", text: summary });
    this.notify(true);
  }

  note(tone: NoteTone, text: string) {
    this.finalize();
    this.status = "";
    this.entries.push({ id: nextId++, kind: "note", text, tone });
    this.notify(true);
  }

  // --- permission prompts ---------------------------------------------------

  requestConfirm(prompt: string): Promise<string> {
    return new Promise<string>((resolve) => {
      this.confirm = {
        prompt,
        resolve: (answer) => {
          this.confirm = null;
          this.entries.push({ id: nextId++, kind: "note", text: `${prompt} → ${answer}`, tone: "info" });
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
