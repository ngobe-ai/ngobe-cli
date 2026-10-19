import { describe, expect, test } from "bun:test";
import { LineUi } from "../src/lineUi.js";
import { Store } from "../src/tui/store.js";

describe("tui store", () => {
  test("shows a status while tools run and the model continues", () => {
    const store = new Store();
    store.write("let me look");
    store.endTurn();
    store.tool("read a.ts");
    expect(store.status).toBe("working…");
  });

  test("clears the status when the agent waits for input", () => {
    const store = new Store();
    store.tool("read a.ts");
    void store.ask();
    expect(store.status).toBe("");
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
    expect(store.status).toBe("thinking…");
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
});
