import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bash } from "../src/tools/bash.js";
import { editFile } from "../src/tools/editFile.js";
import { gitDiff, gitLog, gitStatus } from "../src/tools/git.js";
import { readFile } from "../src/tools/readFile.js";
import { writeFile } from "../src/tools/writeFile.js";
import { glob } from "../src/tools/glob.js";
import { grep } from "../src/tools/grep.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mugamba-test-"));
  await fs.mkdir(path.join(dir, "project/src"), { recursive: true });
  await fs.writeFile(path.join(dir, "project/src/a.ts"), "export const a = 1;\n");
  await fs.writeFile(path.join(dir, "secret.txt"), "TOKEN=hunter2\n");
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
const ctx = () => ({ cwd: path.join(dir, "project") });

describe("glob and grep stay inside the project", () => {
  test("glob finds project files", async () => {
    expect(await glob.run({ pattern: "src/*.ts" }, ctx())).toBe("src/a.ts");
  });

  test.each(["../*", "src/../../*", "./../secret.txt", "/etc/host*"])("glob refuses %p", async (pattern) => {
    await expect(glob.run({ pattern }, ctx())).rejects.toThrow("outside the project");
  });

  test("grep refuses a glob outside the project", async () => {
    await expect(grep.run({ pattern: "TOKEN", glob: "../*.txt" }, ctx())).rejects.toThrow("outside the project");
  });

  test("grep searches project files", async () => {
    expect(await grep.run({ pattern: "const a" }, ctx())).toBe("src/a.ts:1:export const a = 1;");
  });
});

describe("bash", () => {
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  test("reports exit code and output", async () => {
    expect(await bash.run({ command: "echo hi; exit 3" }, ctx())).toBe("exit code 3\nhi\n");
  });

  test("timeout returns on time even when the command started child processes", async () => {
    const start = Date.now();
    const out = await bash.run({ command: "sleep 5; echo done", timeout_seconds: 1 }, ctx());
    expect(out).toStartWith("timed out after 1s");
    expect(Date.now() - start).toBeLessThan(3000);
  }, 10_000);

  test("cancelling kills child processes too", async () => {
    const pidFile = path.join(dir, "pid");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const out = await bash.run(
      { command: `sleep 5 & echo $! > ${pidFile}; wait` },
      { ...ctx(), signal: controller.signal },
    );
    const pid = Number(await fs.readFile(pidFile, "utf8"));
    await Bun.sleep(100); // let the orphan be reaped
    const alive = isAlive(pid);
    if (alive) process.kill(pid, "SIGKILL");
    expect(out).toStartWith("cancelled by user");
    expect(alive).toBe(false);
  }, 10_000);
});

describe("edit_file", () => {
  test("matches LF old_str against a CRLF file and keeps CRLF", async () => {
    const file = path.join(dir, "project/crlf.txt");
    await fs.writeFile(file, "one\r\ntwo\r\nthree\r\n");
    await editFile.run({ path: "crlf.txt", old_str: "one\ntwo", new_str: "one\n2" }, ctx());
    expect(await fs.readFile(file, "utf8")).toBe("one\r\n2\r\nthree\r\n");
  });
});

describe("file safety", () => {
  test("secret files need explicit approval to read or write", () => {
    expect(readFile.needs!({ path: ".env" })).toBe("explicit");
    expect(readFile.needs!({ path: "config/.env.production" })).toBe("explicit");
    expect(readFile.needs!({ path: ".env.example" })).toBe("none");
    expect(readFile.needs!({ path: "certs/server.key" })).toBe("explicit");
    expect(writeFile.needs!({ path: ".env" })).toBe("explicit");
    expect(writeFile.needs!({ path: "src/a.ts" })).toBe("approval");
  });

  test("grep never returns secret file contents", async () => {
    await fs.writeFile(path.join(dir, "project/.env"), "API_TOKEN=abc\n");
    await fs.writeFile(path.join(dir, "project/server.pem"), "API_TOKEN=pem\n");
    await fs.writeFile(path.join(dir, "project/src/b.ts"), "const API_TOKEN = process.env.API_TOKEN;\n");
    const out = await grep.run({ pattern: "API_TOKEN" }, ctx());
    expect(out).toContain("src/b.ts");
    expect(out).not.toContain("API_TOKEN=abc");
    expect(out).not.toContain("API_TOKEN=pem");
  });

  test("edit_file refuses a file changed since it was read", async () => {
    const files = new Map<string, string>();
    const c = { ...ctx(), files };
    await readFile.run({ path: "src/a.ts" }, c);
    await fs.writeFile(path.join(dir, "project/src/a.ts"), "export const a = 2;\n"); // someone else edits it
    await expect(editFile.run({ path: "src/a.ts", old_str: "a = 2", new_str: "a = 3" }, c)).rejects.toThrow("changed on disk");
  });

  test("write_file won't overwrite a file the agent never read", async () => {
    const c = { ...ctx(), files: new Map<string, string>() };
    await expect(writeFile.run({ path: "src/a.ts", content: "x" }, c)).rejects.toThrow("Read it first");
    await readFile.run({ path: "src/a.ts" }, c);
    expect(await writeFile.run({ path: "src/a.ts", content: "x" }, c)).toContain("Wrote");
    expect(await writeFile.run({ path: "src/new.ts", content: "y" }, c)).toContain("Wrote");
  });
});

describe("git tools", () => {
  test("status, diff and log in a repository", async () => {
    const cwd = path.join(dir, "project");
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "first");
    await fs.writeFile(path.join(cwd, "src/a.ts"), "export const a = 42;\n");
    expect(await gitStatus.run({}, ctx())).toContain("M src/a.ts");
    expect(await gitDiff.run({}, ctx())).toContain("+export const a = 42;");
    expect(await gitLog.run({ count: 5 }, ctx())).toContain("first");
  });

  test("refs and paths can't inject options or leave the project", async () => {
    await expect(gitDiff.run({ ref: "--output=/tmp/x" }, ctx())).rejects.toThrow("invalid git ref");
    await expect(gitLog.run({ path: "../" }, ctx())).rejects.toThrow("outside the project");
  });
});
