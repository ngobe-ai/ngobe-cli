import { describe, expect, test } from "bun:test";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { cmdLearn, type BenchSummary } from "../src/learn.js";
import { clusterFailures, signature } from "../src/memory/cluster.js";
import { Memory } from "../src/memory/store.js";
import { testConfig, tmpDir } from "./helpers.js";

function open() {
  const config = testConfig({ memory: true });
  return { memory: Memory.open(config)!, config };
}

describe("experience memory", () => {
  test("survives a restart", () => {
    const { memory, config } = open();
    memory.remember({ project: "/p", kind: "command", key: "test", value: "bun test", source: "observed" });
    memory.close();
    const again = Memory.open(config)!;
    expect(again.recall("/p").map((f) => f.value)).toEqual(["bun test"]);
    again.close();
  });

  test("repeating a fact raises confidence; a new value replaces it", () => {
    const { memory } = open();
    memory.remember({ project: "/p", kind: "command", key: "test", value: "npm test", source: "observed", confidence: 0.5 });
    expect(memory.remember({ project: "/p", kind: "command", key: "test", value: "npm test", source: "observed" }).confidence).toBeCloseTo(0.6);
    const replaced = memory.remember({ project: "/p", kind: "command", key: "test", value: "bun test", source: "observed", confidence: 0.5 });
    expect(replaced).toMatchObject({ value: "bun test", confidence: 0.5 });
  });

  test("refuses to store credentials", () => {
    const { memory } = open();
    expect(() => memory.remember({ project: "/p", kind: "note", key: "deploy", value: "token=ghp_abcdefghijklmnopqrstuvwxyz0123", source: "agent" })).toThrow("credential");
  });

  test("expired facts are not recalled, and version facts expire", () => {
    const { memory } = open();
    memory.remember({ project: "/p", kind: "version", key: "flutter", value: "3.47.7", source: "agent", ttlDays: -1 });
    memory.remember({ project: "*", kind: "convention", key: "style", value: "tabs", source: "user" });
    expect(memory.recall("/p").map((f) => f.key)).toEqual(["style"]);
  });

  test("weakening to zero deletes a fact", () => {
    const { memory } = open();
    memory.remember({ project: "/p", kind: "command", key: "build", value: "make", source: "observed", confidence: 0.3 });
    memory.weaken("/p", "command", "build");
    expect(memory.recall("/p")).toEqual([]);
  });

  test("can be inspected, deleted, cleared and disabled", () => {
    const { memory } = open();
    const f = memory.remember({ project: "/p", kind: "note", key: "a", value: "1", source: "user" });
    memory.remember({ project: "/p", kind: "note", key: "b", value: "2", source: "user" });
    expect(memory.getFact(f.id)?.value).toBe("1");
    expect(memory.deleteFact(f.id)).toBe(true);
    expect(memory.listFacts().length).toBe(1);
    memory.clear();
    expect(memory.listFacts()).toEqual([]);
    memory.setEnabled(false);
    expect(memory.enabled).toBe(false);
  });

  test("is skipped entirely when turned off", () => {
    expect(Memory.open(testConfig({ memory: false }))).toBeNull();
  });

  test("tracks runs and tool reliability", () => {
    const { memory } = open();
    memory.recordToolEvent("r1", "grep", true, null, 20);
    memory.recordToolEvent("r1", "grep", false, "failed", 40);
    expect(memory.toolStats()).toEqual([{ tool: "grep", calls: 2, ok_rate: 0.5, avg_ms: 30 }]);
  });

  test("indexes official docs for offline search", () => {
    const { memory } = open();
    memory.indexDoc("https://docs.flutter.dev/ui/navigation", "Navigation", "Use the Navigator widget.\n\nGoRouter is recommended for deep links.", "flutter", "2026-10-19T00:00:00Z");
    const hits = memory.searchDocs("deep links router", "flutter");
    expect(hits[0]).toMatchObject({ url: "https://docs.flutter.dev/ui/navigation", tech: "flutter" });
    expect(memory.searchDocs("deep links", "dart")).toEqual([]);
  });
});

describe("failure clustering", () => {
  test("normalizes paths, numbers and quoted values", () => {
    expect(signature("Error: Cannot find module '/home/a/x.js' at line 12")).toBe(signature('Error: Cannot find module "/srv/b/y.js" at line 99'));
  });

  test("groups similar failures and counts them", () => {
    const rows = [
      { signature: signature("ENOENT: no such file src/a.ts"), sample: "ENOENT a", tool: "read_file", at: "2026-10-01" },
      { signature: signature("ENOENT: no such file lib/b.ts"), sample: "ENOENT b", tool: "read_file", at: "2026-10-02" },
      { signature: signature("old_str was not found. Re-read the file"), sample: "old_str", tool: "edit_file", at: "2026-10-03" },
    ];
    const clusters = clusterFailures(rows);
    expect(clusters[0]).toMatchObject({ count: 2, tools: ["read_file"], sample: "ENOENT b" });
    expect(clusters.length).toBe(2);
  });
});

describe("prompt variants", () => {
  const summary = (score: number, mustPassOk = true, model = "fake-model"): BenchSummary => ({ model, date: new Date().toISOString(), score, mustPassOk, tasks: [] });

  async function learn(config: ReturnType<typeof testConfig>, ...args: string[]) {
    const loaded = loadConfig(["learn", ...args], { HOME: tmpDir() });
    return cmdLearn({ ...loaded, config: { ...config, model: "fake-model" } });
  }

  test("promotion needs a benchmark, must-pass tasks, and a score at least as good; rollback restores", async () => {
    const { memory, config } = open();
    memory.saveVariant("default", "builtin", "builtin");
    memory.saveVariant("terse", "- be terse", "user");
    memory.saveVariant("risky", "- skip tests", "user");
    memory.close();

    expect(await learn(config, "promote", "terse")).toBe(1); // not benchmarked
    let m = Memory.open(config)!;
    m.setVariantScore("default", 0.7, summary(0.7));
    m.setVariantScore("terse", 0.8, summary(0.8));
    m.setVariantScore("risky", 0.9, summary(0.9, false));
    m.close();

    expect(await learn(config, "promote", "risky")).toBe(1); // failed a must-pass task
    expect(await learn(config, "promote", "terse")).toBe(0);
    m = Memory.open(config)!;
    expect(m.meta("active_variant")).toBe("terse");
    m.close();

    expect(await learn(config, "rollback")).toBe(0);
    m = Memory.open(config)!;
    expect(m.meta("active_variant")).toBeUndefined();
    m.close();
  });

  test("a variant scored with another model can't be promoted", async () => {
    const { memory, config } = open();
    memory.saveVariant("default", "builtin", "builtin");
    memory.saveVariant("other", "- x", "user");
    memory.setVariantScore("default", 0.5, summary(0.5));
    memory.setVariantScore("other", 0.9, summary(0.9, true, "different-model"));
    memory.close();
    expect(await learn(config, "promote", "other")).toBe(1);
  });
});

test("memory files live in the state directory", () => {
  const { memory, config } = open();
  expect(memory.file).toBe(path.join(config.stateDir, "ngobe.db"));
  memory.close();
});
