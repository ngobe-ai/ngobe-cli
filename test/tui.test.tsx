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
