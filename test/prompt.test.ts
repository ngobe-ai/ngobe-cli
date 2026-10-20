import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Memory } from "../src/memory/store.js";
import { ProjectMemory } from "../src/projectMemory.js";
import { createSession } from "../src/session.js";
import type { Message } from "../src/types.js";
import { fakeModel, recordingUi, testConfig, tmpDir } from "./helpers.js";

let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops) s();
  stops = [];
});

// llama.cpp reuses its cache of a request's opening only when it is byte-identical. On a CPU,
// reading the instructions and tools again costs about a minute, so they must not depend on the
// folder, the project, the mode or the day; those go in the session context after them.
test("the system prompt and tools are the same in every folder and mode", async () => {
  const model = fakeModel([{ content: "a" }, { content: "b" }]);
  stops.push(model.stop);
  const a = tmpDir();
  fs.writeFileSync(path.join(a, "AGENTS.md"), "Use tabs in this repo.");
  const b = tmpDir();
  fs.writeFileSync(path.join(b, "package.json"), JSON.stringify({ name: "b", scripts: { test: "vitest run" } }));
  for (const [cwd, mode] of [[a, "edit"], [b, "auto"]] as const) {
    const config = testConfig({ baseURL: model.baseURL, model: "fake-model", maxRetries: 0, cwd, mode });
    const session = await createSession(config, recordingUi().ui, { command: "prompt", memory: null });
    await session.agent.run("hi", new AbortController().signal);
  }
  const [ra, rb] = model.requests;
  const [ma, mb] = [ra.messages as Message[], rb.messages as Message[]];
  expect(mb[0]).toEqual(ma[0]);
  expect(rb.tools).toEqual(ra.tools);
  expect(ma[1].content).toContain(a);
  expect(ma[1].content).toContain("Use tabs in this repo.");
  expect(ma[1].content).toContain("mode: edit");
  expect(mb[1].content).toContain(b);
  expect(mb[1].content).toContain("test: `npm test`");
  expect(mb[1].content).toContain("mode: auto");
});

test("NGOBE.md (lessons, the user, projects) is in the session context of every project", async () => {
  const model = fakeModel([{ content: "a" }]);
  stops.push(model.stop);
  const config = testConfig({ baseURL: model.baseURL, model: "fake-model", maxRetries: 0, cwd: tmpDir(), memory: true });
  config.memoryFile = path.join(tmpDir(), "NGOBE.md");
  const notes = new ProjectMemory(config.memoryFile, config.stateDir);
  notes.lesson("check_latest_version", 'failed with {"ecosystem":"github"}; worked with {"name":"flutter"}');
  notes.noteAboutUser("I prefer pnpm over npm");
  const memory = Memory.open(config);
  const session = await createSession(config, recordingUi().ui, { command: "prompt", memory });
  await session.agent.run("hi", new AbortController().signal);
  const context = (model.requests[0].messages as Message[])[1].content as string;
  expect(context).toContain('check_latest_version: failed with {"ecosystem":"github"}');
  expect(context).toContain("I prefer pnpm over npm");
  memory.close();
});

test("the session context lists the folder's top level", async () => {
  const model = fakeModel([{ content: "a" }]);
  stops.push(model.stop);
  const cwd = tmpDir();
  for (const d of ["hype", "agribz", "node_modules"]) fs.mkdirSync(path.join(cwd, d));
  fs.writeFileSync(path.join(cwd, "notes.md"), "");
  const config = testConfig({ baseURL: model.baseURL, model: "fake-model", maxRetries: 0, cwd });
  const session = await createSession(config, recordingUi().ui, { command: "prompt", memory: null });
  await session.agent.run("hi", new AbortController().signal);
  const context = (model.requests[0].messages as Message[])[1].content as string;
  expect(context).toContain("Top level: agribz/, hype/, notes.md");
  expect(context).not.toContain("node_modules");
});
