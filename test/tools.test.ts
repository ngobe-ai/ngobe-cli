import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bash } from "../src/tools/bash.js";
import { editFile } from "../src/tools/editFile.js";
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
    expect(glob.run({ pattern }, ctx())).rejects.toThrow("outside the project");
  });

  test("grep refuses a glob outside the project", async () => {
    expect(grep.run({ pattern: "TOKEN", glob: "../*.txt" }, ctx())).rejects.toThrow("outside the project");
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
