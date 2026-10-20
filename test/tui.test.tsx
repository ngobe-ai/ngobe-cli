import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { render } from "ink";
import { App } from "../src/tui/App.js";
import { Store } from "../src/tui/store.js";

/** A terminal for Ink: keystrokes go in through push(), every frame is kept. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  private queue: string[] = [];
  setRawMode() {
    return this;
  }
  setEncoding() {
    return this;
  }
  ref() {}
  unref() {}
  resume() {}
  pause() {}
  /** Like Node: a chunk read() returns is also emitted as "data" to any data listener. */
  read() {
    const chunk = this.queue.shift() ?? null;
    if (chunk !== null) this.emit("data", chunk);
    return chunk;
  }
  push(s: string) {
    this.queue.push(s);
    this.emit("readable");
  }
}

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 90;
  rows = 20;
  frames: string[] = [];
  write(s: string) {
    this.frames.push(s);
    return true;
  }
  get last() {
    // eslint-disable-next-line no-control-regex
    return (this.frames.at(-1) ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  }
}

const unmounts: (() => void)[] = [];
afterEach(() => {
  for (const u of unmounts.splice(0)) u();
});

const tick = () => new Promise((r) => setTimeout(r, 60));

test("the mouse wheel scrolls the conversation; the header and the prompt stay, and nothing is typed", async () => {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const store = new Store("edit");
  void store.ask(); // the prompt is open, as in a chat waiting for the user
  for (let i = 1; i <= 40; i++) store.note("info", `line ${i}`);
  const app = render(<App store={store} config={{ model: "m", baseURL: "http://x", cwd: "/tmp/p", mode: "edit", version: "1.0.0" }} onInterrupt={() => false} />, {
    stdout: stdout as never,
    stdin: stdin as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  unmounts.push(() => app.unmount());
  await tick();
  expect(stdout.last).toContain("line 40");

  for (let i = 0; i < 6; i++) stdin.push("\x1b[<64;10;8M"); // wheel up, 3 lines each
  await tick();
  expect(stdout.last).not.toContain("line 40");
  expect(stdout.last).toContain("more lines below");
  expect(stdout.last).toContain("NGOBE v1.0.0"); // the header is still on screen
  expect(stdout.last).not.toContain("[<64");

  for (let i = 0; i < 6; i++) stdin.push("\x1b[<65;10;8M"); // wheel down
  await tick();
  expect(stdout.last).toContain("line 40");
  expect(stdout.last).not.toContain("[<65");
});

test("ctrl+v pastes a screenshot from the clipboard as a file path in the prompt", async () => {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const store = new Store("edit");
  void store.ask();
  let asked = 0;
  const app = render(
    <App store={store} config={{ model: "m", baseURL: "http://x", cwd: "/tmp/p", mode: "edit", version: "1.0.0" }} onInterrupt={() => false} onPasteImage={async () => (++asked, "/tmp/state/clipboard/shot-1.png")} />,
    { stdout: stdout as never, stdin: stdin as never, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  unmounts.push(() => app.unmount());
  await tick();
  stdin.push("rebuild this UI ");
  await tick();
  stdin.push("\x16"); // ctrl+v
  await tick();
  expect(asked).toBe(1);
  expect(stdout.last).toContain("rebuild this UI /tmp/state/clipboard/shot-1.png");
});

test("an edit shows like Claude Code's: line numbers, - and + rows, context", async () => {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const store = new Store("edit");
  const app = render(<App store={store} config={{ model: "m", baseURL: "http://x", cwd: "/tmp/p", mode: "edit", version: "1.0.0" }} onInterrupt={() => false} />, {
    stdout: stdout as never,
    stdin: stdin as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  unmounts.push(() => app.unmount());
  store.toolUpdate({
    id: "1",
    label: "Update",
    target: "src/memory/db.ts",
    state: "ok",
    summary: "Updated src/memory/db.ts (+2 −1)",
    preview: [
      { text: "  try {", tone: "context", line: 44, lang: "ts" },
      { text: "    raw = new DatabaseSync(file, undefined);", tone: "remove", line: 45, lang: "ts" },
      { text: "    // pass options only when there are some", tone: "add", line: 45, lang: "ts" },
      { text: "    raw = new DatabaseSync(file);", tone: "add", line: 46, lang: "ts" },
      { text: "  } finally {", tone: "context", line: 47, lang: "ts" },
    ],
  });
  await tick();
  const frame = stdout.last;
  expect(frame).toContain("Updated src/memory/db.ts (+2 −1)");
  expect(frame).toMatch(/44 {3}  try \{/);
  // "45 -" then the separator space and the line's own 4-space indent.
  expect(frame).toMatch(/45 - {5}raw = new DatabaseSync\(file, undefined\);/);
  expect(frame).toMatch(/45 \+ {5}\/\/ pass options only when there are some/);
  expect(frame).toMatch(/46 \+ {5}raw = new DatabaseSync\(file\);/);
  // (The red and green row backgrounds need a color terminal; this fake one has none.)
});
