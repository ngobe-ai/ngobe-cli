import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Agent } from "../src/agent.js";
import { LLM } from "../src/llm.js";
import { Permissions } from "../src/permissions.js";
import { ProjectMemory, isResumeRequest, userNote } from "../src/projectMemory.js";
import type { Message, Tool } from "../src/types.js";
import { fakeModel, recordingUi, testConfig, tmpDir, type FakeTurn } from "./helpers.js";

let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

/** ~/me/COTE: a folder of projects, no manifest of its own. */
function workspace() {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, "hype", "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "hype", "pubspec.yaml"), "name: eq_app\ndescription: Enjoy the power of hype muzik\ndependencies:\n  flutter:\n    sdk: flutter\n");
  fs.writeFileSync(path.join(root, "hype", "lib", "main.dart"), "void main() {}\n");
  fs.mkdirSync(path.join(root, "tasye"));
  fs.writeFileSync(path.join(root, "tasye", "package.json"), "{}");
  return root;
}

function memoryIn(dir = tmpDir()) {
  return new ProjectMemory(path.join(dir, "NGOBE.md"), path.join(dir, "state"));
}

const editTool = (): Tool => ({
  name: "edit_file",
  label: "Edit",
  description: "edit",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  risk: "write",
  run: async () => "Updated",
});

function agentWith(turns: FakeTurn[], cwd: string, memory: ProjectMemory, onRequest?: Parameters<typeof fakeModel>[1]) {
  const tools = [editTool()];
  const model = fakeModel(turns, onRequest);
  stops.push(model.stop);
  const config = testConfig({ baseURL: model.baseURL, model: "fake-model", maxRetries: 0, cwd, mode: "auto" });
  const { ui } = recordingUi("y");
  const agent = new Agent({ config, llm: new LLM(config), tools, ui, perms: new Permissions(ui, "auto"), systemPrompt: "sys", memory: null, projectMemory: memory });
  return { agent, model };
}

describe("NGOBE.md", () => {
  test("work is logged under the project it touched, with what the project is", async () => {
    const cwd = workspace();
    const memory = memoryIn();
    const { agent } = agentWith([{ toolCalls: [{ name: "edit_file", arguments: '{"path": "hype/lib/main.dart"}' }] }, { content: "Fixed the startup crash." }], cwd, memory);
    await agent.run("fix the crash on startup in hype", new AbortController().signal);
    const md = fs.readFileSync(memory.file, "utf8");
    expect(md).toContain("# NGOBE.md");
    expect(md).toContain(`### hype · ${path.join(cwd, "hype")}`);
    expect(md).toContain('"eq_app": Enjoy the power of hype muzik');
    expect(md).toMatch(/- \d{4}-\d\d-\d\d \d\d:\d\d · "fix the crash on startup in hype" → changed hype\/lib\/main\.dart/);
  });

  test("a chat without tool calls is not logged", async () => {
    const cwd = workspace();
    const memory = memoryIn();
    const { agent } = agentWith([{ content: "Hello!" }], cwd, memory);
    await agent.run("hello", new AbortController().signal);
    expect(fs.existsSync(memory.file)).toBe(false);
  });

  test("keeps the user's own edits and other sections, and the newest 15 entries per project", () => {
    const memory = memoryIn();
    const project = tmpDir();
    fs.writeFileSync(memory.file, "# NGOBE.md\n\n## My notes\n\nThe staging server is staging.example.com.\n");
    for (let i = 1; i <= 20; i++) memory.logWork(project, `entry ${i}`);
    const md = fs.readFileSync(memory.file, "utf8");
    expect(md).toContain("## My notes\n\nThe staging server is staging.example.com.");
    expect(md).not.toContain("entry 5\n");
    expect(md).toContain("entry 6");
    expect(md).toContain("entry 20");
  });

  test("what the user asks it to remember goes in About you; secrets never do", async () => {
    expect(userNote("remember that I prefer pnpm over npm")).toBe("I prefer pnpm over npm");
    expect(userNote("Always run the tests after editing")).toBe("Always run the tests after editing");
    expect(userNote("never mind")).toBeNull();
    expect(userNote("fix the bug")).toBeNull();
    const memory = memoryIn();
    memory.noteAboutUser("I prefer pnpm over npm");
    memory.noteAboutUser("my token is ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    const md = fs.readFileSync(memory.file, "utf8");
    expect(md).toContain("## About you\n\n- I prefer pnpm over npm");
    expect(md).not.toContain("ghp_");
  });

  test("the session context has the user, the lessons, this project's log and the projects worked on here", () => {
    const cwd = workspace();
    const memory = memoryIn();
    memory.noteAboutUser("I prefer pnpm over npm");
    memory.lesson("check_latest_version", '"github projects are named owner/repo" with {"name":"flutter","ecosystem":"github"}; worked with {"name":"flutter"}');
    memory.logWork(path.join(cwd, "hype"), '"fix the crash" → changed hype/lib/main.dart', "Flutter (pubspec.yaml)");
    const fromWorkspace = memory.contextFor(cwd);
    expect(fromWorkspace).toContain("I prefer pnpm over npm");
    expect(fromWorkspace).toContain("check_latest_version");
    expect(fromWorkspace).toContain("hype");
    expect(fromWorkspace).toContain("fix the crash");
    expect(memory.contextFor(path.join(cwd, "hype", "lib"))).toContain("fix the crash"); // inside the project
    expect(fromWorkspace.length).toBeLessThan(2_200);
  });
});

describe("resuming", () => {
  test("recognizes the ways people ask to pick up again", () => {
    for (const t of ["continue", "Continue.", "resume", "where did we stop?", "where did we stop", "where were we", "pick up where we left off", "ok, keep going", "what were we working on?", "carry on"]) {
      expect(isResumeRequest(t)).toBe(true);
    }
    for (const t of ["continue the loop until i == 10 in sum.js", "fix the bug", "how do I resume a download in dio?"]) {
      expect(isResumeRequest(t)).toBe(false);
    }
  });

  test("after a dropped connection, a new session's 'continue' gets the unfinished request and its progress", async () => {
    const cwd = workspace();
    const memory = memoryIn();
    // The first session edits a file, then the model server becomes unreachable.
    const unreachable = (_body: unknown, n: number) => (n >= 2 ? new Response("upstream unreachable", { status: 503 }) : undefined);
    const first = agentWith([{ toolCalls: [{ name: "edit_file", arguments: '{"path": "hype/lib/main.dart"}' }] }], cwd, memory, unreachable);
    await first.agent.run("add offline playlists to hype", new AbortController().signal).catch(() => {});
    expect(memory.lastWork(cwd)).toMatchObject({ request: "add offline playlists to hype", files: ["hype/lib/main.dart"] });
    expect(memory.lastWork(cwd)!.outcome).not.toBe("completed");

    // A new session, the next day: "where did we stop?"
    const second = agentWith([{ content: "We were adding offline playlists; main.dart is changed. Continuing." }], cwd, memory);
    await second.agent.run("where did we stop?", new AbortController().signal);
    const asked = (second.model.requests[0].messages as Message[]).at(-1)!.content as string;
    expect(asked).toContain("where did we stop?");
    expect(asked).toContain("add offline playlists to hype");
    expect(asked).toContain("hype/lib/main.dart");
    expect(asked).toContain("Edit(hype/lib/main.dart)");
    // Opening ngobe in the project itself finds the same work.
    expect(memory.lastWork(path.join(cwd, "hype"))?.request).toBe("add offline playlists to hype");
  });

  test("asking where we stopped doesn't overwrite the record", async () => {
    const cwd = workspace();
    const memory = memoryIn();
    const first = agentWith([{ toolCalls: [{ name: "edit_file", arguments: '{"path": "hype/lib/main.dart"}' }] }, { content: "Done." }], cwd, memory);
    await first.agent.run("add offline playlists to hype", new AbortController().signal);
    const second = agentWith([{ content: "We finished adding offline playlists." }], cwd, memory);
    await second.agent.run("where did we stop?", new AbortController().signal);
    expect(memory.lastWork(cwd)).toMatchObject({ request: "add offline playlists to hype", outcome: "completed" });
  });
});
