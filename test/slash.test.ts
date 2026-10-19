import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent } from "../src/agent.js";
import { loadAgents, parseAgent } from "../src/agents.js";
import { LLM } from "../src/llm.js";
import { Permissions } from "../src/permissions.js";
import type { Session } from "../src/session.js";
import { execFileSync } from "node:child_process";
import { findCommand, reviewRequest, runSlash } from "../src/slash.js";
import { buildTools } from "../src/tools/index.js";
import { taskTool } from "../src/tools/task.js";
import { isTrusted, trustFolder } from "../src/trust.js";
import type { Message, Tool } from "../src/types.js";
import { fakeModel, recordingUi, testConfig, tmpDir, type FakeTurn } from "./helpers.js";

let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

function session(turns: FakeTurn[] = [], tools: Tool[] = []) {
  const model = fakeModel(turns);
  stops.push(model.stop);
  const dir = tmpDir();
  const config = testConfig({ baseURL: model.baseURL, model: "fake-model", maxRetries: 0, cwd: dir, mode: "edit" });
  const { ui, log } = recordingUi("y");
  const perms = new Permissions(ui, config.mode);
  const llm = new LLM(config);
  const agent = new Agent({ config, llm, tools, ui, perms, systemPrompt: "test", memory: null });
  const s = { agent, llm, memory: null, tools, perms, agents: loadAgents(dir, path.join(dir, "cfg")) } as unknown as Session;
  const env = { config, session: s, ui, abortable: <T>(fn: (signal: AbortSignal) => Promise<T>) => fn(new AbortController().signal) };
  return { env, log, agent, config, model, dir };
}

describe("slash commands", () => {
  test("names and aliases resolve like other coding agents", () => {
    expect(findCommand("subagents")?.name).toBe("agents");
    expect(findCommand("new")?.name).toBe("clear");
    expect(findCommand("usage")?.name).toBe("cost");
    expect(findCommand("nope")).toBeUndefined();
  });

  test("/mode switches the agent's mode; unknown commands warn", async () => {
    const { env, agent, log } = session();
    await runSlash("/mode plan", env);
    expect(agent.currentMode).toBe("plan");
    await runSlash("/frobnicate", env);
    expect(log.notes.at(-1)).toContain("Unknown command /frobnicate");
  });

  test("/model lists the server's models and switches by number", async () => {
    const { env, config, log } = session();
    const xdg = tmpDir();
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      await runSlash("/model", env);
      expect(log.notes.at(-1)).toContain("1. fake-model");
      await runSlash("/model 1", env);
      expect(config.model).toBe("fake-model");
      expect(JSON.parse(fs.readFileSync(path.join(xdg, "ngobe", "config.json"), "utf8")).model).toBe("fake-model");
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
  });

  test("/init and /review become requests for the agent; /exit quits", async () => {
    const { env } = session();
    const init = await runSlash("/init", env);
    expect(init.kind === "prompt" && init.text).toContain("AGENTS.md");
    const review = await runSlash("/review", env);
    expect(review.kind === "prompt" && review.text).toContain("Review");
    expect((await runSlash("/quit", env)).kind).toBe("exit");
  });

  test("a review request carries the diff itself (the lean model needs no tool call to see it), never secrets", async () => {
    const dir = tmpDir();
    const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
    run("init", "-q");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "t");
    fs.writeFileSync(path.join(dir, "a.js"), "export const a = 1;\n");
    fs.writeFileSync(path.join(dir, ".env"), "TOKEN=old\n");
    run("add", "-A");
    run("commit", "-qm", "init");
    fs.writeFileSync(path.join(dir, "a.js"), "export const a = 2;\n");
    fs.writeFileSync(path.join(dir, ".env"), "TOKEN=hunter2\n");
    const text = await reviewRequest(dir, "", 32_000);
    expect(text).toContain("+export const a = 2;");
    expect(text).not.toContain("hunter2");
    expect(await reviewRequest(dir, "HEAD", 32_000)).toContain("since HEAD");
    await expect(reviewRequest(dir, "--output=/tmp/x", 32_000)).rejects.toThrow("invalid git ref");
  });

  test("/agents new writes a template that loads as a custom agent", async () => {
    const { env, dir } = session();
    await runSlash("/agents new test-runner", env);
    const agents = loadAgents(dir, path.join(dir, "cfg"));
    expect(agents.find((a) => a.name === "test-runner")).toMatchObject({ source: "project", tools: ["read_file", "glob", "grep", "bash"] });
  });

  test("/context and /cost report the session", async () => {
    const { env, agent, log } = session([{ content: "hi" }]);
    await agent.run("hello", new AbortController().signal);
    await runSlash("/context", env);
    expect(log.notes.at(-1)).toMatch(/% of ~/);
    await runSlash("/cost", env);
    expect(log.notes.at(-1)).toContain("1 request");
  });

  test("/compact summarizes the conversation", async () => {
    const { env, agent, model, log } = session([{ content: "first answer" }, { content: "SUMMARY: said hello" }]);
    await agent.run("hello", new AbortController().signal);
    await runSlash("/compact", env);
    expect(log.notes.at(-1)).toContain("Compacted");
    expect(agent.contextUsage().history).toBe(0);
    expect(model.requests.length).toBe(2);
  });
});

describe("folder trust", () => {
  test("trusting a folder trusts its subfolders, but trusting home does not trust everything", () => {
    const state = tmpDir();
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "ngobe-trust-"));
    fs.mkdirSync(path.join(project, "sub"));
    expect(isTrusted(project, state)).toBe(false);
    trustFolder(project, state);
    expect(isTrusted(project, state)).toBe(true);
    expect(isTrusted(path.join(project, "sub"), state)).toBe(true);
    expect(isTrusted(path.dirname(project), state)).toBe(false);

    const state2 = tmpDir();
    trustFolder(os.homedir(), state2);
    expect(isTrusted(os.homedir(), state2)).toBe(true);
    expect(isTrusted(project, state2)).toBe(false);
  });
});

describe("sub-agents", () => {
  test("parses Claude Code style definitions and maps their tool names", () => {
    const def = parseAgent("---\nname: Reviewer\ndescription: Reviews diffs\ntools: Read, Grep, Bash\n---\nBe strict.", "project");
    expect(def).toMatchObject({ name: "reviewer", description: "Reviews diffs", tools: ["read_file", "grep", "bash"], prompt: "Be strict." });
    expect(parseAgent("no frontmatter", "project")).toBeNull();
  });

  test("lean profile: ~10 tools and no task tool until a custom agent exists", () => {
    const config = testConfig();
    const builtIn = loadAgents(tmpDir(), tmpDir());
    const lean = buildTools(config, { memory: false, agents: builtIn });
    expect(lean.map((t) => t.name)).not.toContain("task");
    expect(lean.map((t) => t.name)).toEqual(expect.arrayContaining(["git_status", "git_diff"])); // ask/plan modes have no bash
    expect(lean.length).toBeLessThanOrEqual(13);
    expect(lean.find((t) => t.name === "read_file")!.description.length).toBeLessThan(120);
    const custom = [...builtIn, { name: "x", description: "x", prompt: "", source: "project" as const }];
    expect(buildTools(config, { memory: false, agents: custom }).map((t) => t.name)).toContain("task");
    const full = buildTools({ ...config, toolProfile: "full" }, { memory: false, agents: builtIn });
    expect(full.map((t) => t.name)).toEqual(expect.arrayContaining(["task", "todo_write", "multi_edit", "git_status"]));
  });

  test("the task tool runs a sub-agent in a fresh context and returns its report", async () => {
    const agents = loadAgents(tmpDir(), tmpDir());
    const read: Tool = { name: "read_file", description: "read", parameters: { type: "object", properties: {} }, risk: "safe", run: async () => "file text" };
    const { agent, model, log } = session(
      [
        { toolCalls: [{ name: "task", arguments: JSON.stringify({ description: "find it", prompt: "Where is X?", subagent_type: "explore" }) }] },
        { toolCalls: [{ name: "read_file", arguments: "{}" }] }, // the sub-agent
        { content: "X is in a.ts:3" }, // the sub-agent's report
        { content: "It's in a.ts." }, // the main agent
      ],
      [read, taskTool(agents)],
    );
    const result = await agent.run("where is X?", new AbortController().signal);
    expect(result.text).toBe("It's in a.ts.");
    const sub = model.requests[1].messages as Message[];
    expect(sub[0].content).toContain('"explore" sub-agent');
    expect(sub.at(-1)?.content).toBe("Where is X?"); // fresh context: only the task
    expect((model.requests[1].tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(["read_file"]);
    const last = model.requests[3].messages as Message[];
    expect(last.find((m) => m.role === "tool")?.content).toBe("X is in a.ts:3");
    expect(log.views.some((v) => v.label === "explore › read_file")).toBe(true);
  });
});
