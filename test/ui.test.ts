import { describe, expect, test } from "bun:test";
import { activityLine, LineUi, toolLines } from "../src/lineUi.js";
import { compactLogo, LOGO, LOGO_WIDTH, logoFrame, SWEEP_FRAMES } from "../src/tui/logo.js";
import { headerHeight } from "../src/tui/Header.js";
import { Store } from "../src/tui/store.js";
import { renderMarkdown } from "../src/markdown.js";
import { formatDuration, formatTokens, runDoneLine } from "../src/ui.js";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("tui store", () => {
  test("a tool call is one entry, updated in place when it finishes", () => {
    const store = new Store();
    store.write("let me look");
    store.endTurn();
    store.toolUpdate({ id: "c1", label: "Read", target: "a.ts", state: "running" });
    const running = store.entries.at(-1)!.view;
    store.toolUpdate({ id: "c1", label: "Read", target: "a.ts", state: "ok", summary: "Read 3 lines" });
    expect(store.entries.map((e) => e.kind)).toEqual(["assistant", "tool"]);
    expect(store.entries.at(-1)!.view).toMatchObject({ state: "ok", summary: "Read 3 lines" });
    expect(store.entries.at(-1)!.view).not.toBe(running); // new object, so memoized rows re-render
  });

  test("tracks the activity line, todos and the run summary", () => {
    const store = new Store();
    store.setActivity({ label: "Running tests", since: Date.now(), tokens: 10 });
    expect(store.busy).toBe(true);
    store.setTodos([{ content: "a", status: "completed" }]);
    store.setActivity(null);
    store.runDone({ outcome: "completed", ms: 1500, tokens: 2000, toolCalls: 2 });
    expect(store.busy).toBe(false);
    expect(store.entries.at(-1)).toMatchObject({ kind: "done", text: "Done in 1.5s · 2.0k tokens · 2 tool calls" });
    expect(store.todos).toEqual([]); // all done: cleared
  });

  test("queues type-ahead without splitting the streaming reply", async () => {
    const store = new Store();
    store.write("part one, ");
    store.submit("next question"); // the agent is busy, nothing is waiting in ask()
    store.write("part two");
    store.endTurn();
    expect(store.entries.map((e) => [e.kind, e.text])).toEqual([["assistant", "part one, part two"]]);
    expect(store.queuedCount).toBe(1);

    expect(await store.ask()).toBe("next question");
    expect(store.entries.at(-1)).toMatchObject({ kind: "user", text: "next question" });
    expect(store.queuedCount).toBe(0);
  });

  test("a whitespace-only reply leaves no empty entry", () => {
    const store = new Store();
    store.write("\n");
    store.endTurn();
    expect(store.entries).toEqual([]);
  });
});

describe("line ui", () => {
  test("denies instead of reading an answer when there is no terminal", async () => {
    const ui = new LineUi(false);
    try {
      expect(await ui.confirm("allow write a.txt?")).toBe("n");
    } finally {
      ui.close();
    }
  });

  test("prints tool calls Claude Code style", () => {
    const lines = toolLines({
      id: "1",
      label: "Update",
      target: "src/a.ts",
      state: "ok",
      summary: "+1 −1",
      preview: [
        { text: "- a = 1", tone: "remove" },
        { text: "+ a = 2", tone: "add" },
      ],
    }).map(plain);
    expect(lines).toEqual(["⏺ Update(src/a.ts)", "  ⎿  +1 −1", "     - a = 1", "     + a = 2"]);
  });

  test("status line shows elapsed time, tokens and how to interrupt", () => {
    const line = plain(activityLine({ label: "Running tests", since: 0, tokens: 2800 }, 0, 34_000));
    expect(line).toBe("· Running tests… (34s · 2.8k tokens · ctrl+c to interrupt)");
  });
});

describe("formatting", () => {
  test("durations, tokens and run summaries", () => {
    expect(formatDuration(8_200)).toBe("8.2s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(3_100)).toBe("3.1k");
    expect(runDoneLine({ outcome: "cancelled", ms: 12_000, tokens: 500, toolCalls: 1 })).toBe("Interrupted after 12s · 500 tokens · 1 tool call");
  });
});

describe("banner", () => {
  test("the art is rectangular and spells the letters", () => {
    expect(LOGO).toHaveLength(6);
    for (const line of LOGO) expect([...line].length).toBe(LOGO_WIDTH);
  });

  test("frames keep the art intact and leave spaces uncoloured", () => {
    for (const frame of [0, 5, SWEEP_FRAMES + 10]) {
      const rows = logoFrame({ frame, busy: frame === 5 });
      expect(rows.map((r) => r.map((s) => s.text).join(""))).toEqual(LOGO);
      for (const r of rows) for (const s of r) if (!s.text.trim()) expect(s.color).toBeUndefined();
    }
  });

  test("the intro reveals the letters from the left", () => {
    const rows = logoFrame({ frame: 0, busy: false, reveal: 10 });
    expect(rows[0].map((s) => s.text).join("")).toBe(LOGO[0].slice(0, 10).padEnd(LOGO_WIDTH));
  });

  test("the beam lights up cells during a sweep and is gone while resting", () => {
    const color = (frame: number) => JSON.stringify(logoFrame({ frame, busy: false }));
    expect(color(SWEEP_FRAMES / 2)).not.toBe(color(SWEEP_FRAMES + 20));
    expect(color(SWEEP_FRAMES + 20)).toBe(color(SWEEP_FRAMES + 40)); // static between sweeps
  });

  test("short or narrow terminals get the one-line banner", () => {
    expect(headerHeight(20, 120)).toBe(2);
    expect(headerHeight(40, 30)).toBe(2);
    expect(headerHeight(40, 120)).toBeGreaterThan(6);
    expect(compactLogo(0, false).map((s) => s.text).join("")).toBe("NGOBE");
  });
});

describe("markdown", () => {
  test("renders a reply for the terminal: no fence markers, no ** or backticks", () => {
    const lines = renderMarkdown("# Plan\n1. **Root**: `/a/b`\n- item\n```ts\nconst x = 1;\n```").map(plain);
    expect(lines).toEqual(["Plan", "1. Root: /a/b", "• item", "  const x = 1;"]);
  });
});
