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

function mount(rows = 30) {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  stdout.rows = rows;
  const store = new Store("edit");
  const app = render(<App store={store} config={{ model: "m", baseURL: "http://x", cwd: "/tmp/p", mode: "edit", version: "1.0.0" }} onInterrupt={() => false} />, {
    stdout: stdout as never,
    stdin: stdin as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  unmounts.push(() => app.unmount());
  return { stdin, stdout, store };
}

test("a menu (/model) moves with the arrows or j/k, chooses with enter, and s chooses for this session", async () => {
  const { stdin, stdout, store } = mount();
  const options = [
    { value: "docker.io/ngobe/qwen2.5-coder-7b:16k", label: "docker.io/ngobe/qwen2.5-coder-7b:16k ✔", description: "7.6B params · 4.4 GB · 32k context" },
    { value: "docker.io/ngobe/qwen3-vl-2b:6k", label: "docker.io/ngobe/qwen3-vl-2b:6k", description: "2.1B params · 1.3 GB" },
  ];
  const first = store.requestSelect({ title: "Select model", options, alt: { key: "s", label: "this session only" } });
  await tick();
  if (process.env.SNAPSHOT) console.log(stdout.last);
  expect(stdout.last).toContain("Select model");
  expect(stdout.last).toMatch(/❯ 1\. docker\.io\/ngobe\/qwen2\.5-coder-7b:16k ✔\s+7\.6B params · 4\.4 GB · 32k context/);
  expect(stdout.last).toContain("↑/↓ choose · enter select · s this session only · esc cancel");
  stdin.push("j");
  await tick();
  expect(stdout.last).toMatch(/❯ 2\. docker\.io\/ngobe\/qwen3-vl-2b:6k/);
  stdin.push("s");
  expect(await first).toEqual({ values: ["docker.io/ngobe/qwen3-vl-2b:6k"], alt: true });
  // A number chooses at once; esc cancels.
  const second = store.requestSelect({ title: "Select model", options });
  await tick();
  stdin.push("2");
  expect(await second).toEqual({ values: ["docker.io/ngobe/qwen3-vl-2b:6k"], alt: false });
  const third = store.requestSelect({ title: "Select model", options });
  await tick();
  stdin.push("\x1b");
  expect(await third).toBeNull();
});

test("a multi-select (/agents tools) checks with space and returns the checked values", async () => {
  const { stdin, stdout, store } = mount();
  const answer = store.requestSelect({
    title: "Select tools (space checks, enter when done)",
    multi: true,
    options: [
      { value: "*", label: "All tools", description: "everything the main agent has", checked: true },
      { value: "group:read", label: "Read-only tools", description: "read_file, glob, grep" },
      { value: "bash", label: "bash", description: "Run a shell command" },
    ],
  });
  await tick();
  if (process.env.SNAPSHOT) console.log(stdout.last);
  expect(stdout.last).toMatch(/❯ \[x\] All tools\s+everything the main agent has/);
  expect(stdout.last).toContain("space check · enter done");
  stdin.push(" "); // uncheck All tools
  stdin.push("\x1b[B"); // down
  stdin.push(" ");
  await tick();
  expect(stdout.last).toMatch(/❯ \[x\] Read-only tools/);
  expect(stdout.last).toMatch(/\[ \] All tools/);
  stdin.push("\r");
  expect(await answer).toEqual({ values: ["group:read"], alt: false });
});

test("a question is answered in the prompt box: enter gives it the text, not a new request", async () => {
  const { stdin, stdout, store } = mount();
  void store.ask(); // the chat is waiting for a request, as during /agents
  const answer = store.requestInput({ title: "Describe what this agent should do and when it should be used", placeholder: "e.g. reviews my changes" });
  await tick();
  if (process.env.SNAPSHOT) console.log(stdout.last);
  expect(stdout.last).toContain("Describe what this agent should do and when it should be used");
  expect(stdout.last).toContain("e.g. reviews my changes");
  stdin.push("runs the tests");
  await tick();
  stdin.push("\r");
  expect(await answer).toBe("runs the tests");
  expect(store.entries.filter((e) => e.kind === "user")).toEqual([]); // not sent to the agent
});
