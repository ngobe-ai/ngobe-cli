import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bash, bashOutput, killShell } from "../src/tools/bash.js";
import { editFile, multiEdit } from "../src/tools/editFile.js";
import { exitPlanMode, todoWrite } from "../src/tools/plan.js";
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
  test("matches LF old_string against a CRLF file and keeps CRLF", async () => {
    const file = path.join(dir, "project/crlf.txt");
    await fs.writeFile(file, "one\r\ntwo\r\nthree\r\n");
    await editFile.run({ path: "crlf.txt", old_string: "one\ntwo", new_string: "one\n2" }, ctx());
    expect(await fs.readFile(file, "utf8")).toBe("one\r\n2\r\nthree\r\n");
  });

  test("returns the edited lines, numbered, so the model can check them", async () => {
    const out = await editFile.run({ path: "src/a.ts", old_string: "a = 1", new_string: "a = 2" }, ctx());
    expect(out).toContain("1\texport const a = 2;");
  });

  test("an ambiguous match is refused unless replace_all is set", async () => {
    await fs.writeFile(path.join(dir, "project/src/a.ts"), "x = 1;\nx = 1;\n");
    await expect(editFile.run({ path: "src/a.ts", old_string: "x = 1", new_string: "x = 2" }, ctx())).rejects.toThrow("matches 2 places");
    await editFile.run({ path: "src/a.ts", old_string: "x = 1", new_string: "x = 2", replace_all: true }, ctx());
    expect(await fs.readFile(path.join(dir, "project/src/a.ts"), "utf8")).toBe("x = 2;\nx = 2;\n");
  });

  test("needs the file to have been read first (when tracking reads)", async () => {
    const c = { ...ctx(), files: new Map<string, string>() };
    await expect(editFile.run({ path: "src/a.ts", old_string: "a = 1", new_string: "a = 2" }, c)).rejects.toThrow(/read/i);
    await readFile.run({ path: "src/a.ts" }, c);
    await editFile.run({ path: "src/a.ts", old_string: "a = 1", new_string: "a = 2" }, c);
  });

  test("summarizes as a diff with added and removed lines", () => {
    const shown = editFile.summarize!({ path: "src/a.ts", old_string: "a = 1", new_string: "a = 2\nb = 3" }, "", 5);
    expect(shown.summary).toMatch(/\+2.*−1|added 2|\+2/);
    expect(shown.preview?.some((p) => p.tone === "add")).toBe(true);
    expect(shown.preview?.some((p) => p.tone === "remove")).toBe(true);
  });
});

describe("multi_edit", () => {
  test("applies every edit, or none when one fails", async () => {
    const file = path.join(dir, "project/src/a.ts");
    await fs.writeFile(file, "const a = 1;\nconst b = 2;\n");
    await expect(
      multiEdit.run({ path: "src/a.ts", edits: [{ old_string: "a = 1", new_string: "a = 10" }, { old_string: "missing", new_string: "x" }] }, ctx()),
    ).rejects.toThrow("not found");
    expect(await fs.readFile(file, "utf8")).toBe("const a = 1;\nconst b = 2;\n");
    await multiEdit.run({ path: "src/a.ts", edits: [{ old_string: "a = 1", new_string: "a = 10" }, { old_string: "b = 2", new_string: "b = 20" }] }, ctx());
    expect(await fs.readFile(file, "utf8")).toBe("const a = 10;\nconst b = 20;\n");
  });
});

describe("read_file", () => {
  test("numbers lines and pages through long files", async () => {
    await fs.writeFile(path.join(dir, "project/long.txt"), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"));
    const out = await readFile.run({ path: "long.txt", offset: 10, limit: 5 }, ctx());
    expect(out).toContain("    10\tline 10");
    expect(out).toContain("    14\tline 14");
    expect(out).not.toContain("line 15");
    expect(out).toContain("offset=15");
  });

  test("describes binary files instead of refusing them; directories get a clear message", async () => {
    await fs.writeFile(path.join(dir, "project/img.bin"), Buffer.from([0, 1, 2, 0, 255]));
    expect(await readFile.run({ path: "img.bin" }, ctx())).toMatch(/^\[binary data/);
    await expect(readFile.run({ path: "src" }, ctx())).rejects.toThrow(/director/i);
  });

  test("a file that isn't there: files with that name in the project are suggested", async () => {
    await expect(readFile.run({ path: "a.ts" }, ctx())).rejects.toThrow("Did you mean src/a.ts?");
    await expect(readFile.run({ path: "nowhere.ts" }, ctx())).rejects.toThrow("Use glob to find the right path.");
  });
});

describe("todo_write and exit_plan_mode", () => {
  test("todo_write stores the list and allows one item in progress", async () => {
    let stored: unknown[] = [];
    const c = { ...ctx(), todos: { list: [], set: (l: unknown[]) => (stored = l) } };
    const todos = [
      { content: "Read the code", status: "completed" },
      { content: "Fix the parser", status: "in_progress", activeForm: "Fixing the parser" },
      { content: "Run the tests", status: "pending" },
    ];
    expect(await todoWrite.run({ todos }, c as never)).toContain("2 of 3 left");
    expect(stored).toHaveLength(3);
    await expect(todoWrite.run({ todos: todos.map((t) => ({ ...t, status: "in_progress" })) }, c as never)).rejects.toThrow("only one");
    expect(todoWrite.summarize!({ todos }, "", 1).preview?.[0]).toMatchObject({ text: "☒ Read the code", tone: "dim" });
  });

  test("exit_plan_mode switches the mode only when the user approves", async () => {
    const modes: string[] = [];
    const c = (answer: string) => ({ ...ctx(), confirm: async () => answer, setMode: (m: string) => modes.push(m) });
    expect(await exitPlanMode.run({ plan: "1. fix" }, c("n") as never)).toContain("did not approve");
    expect(await exitPlanMode.run({ plan: "1. fix" }, c("y") as never)).toContain("edit");
    expect(await exitPlanMode.run({ plan: "1. fix" }, c("a") as never)).toContain("auto");
    expect(modes).toEqual(["edit", "auto"]);
  });
});

describe("search results", () => {
  test("glob lists newest files first", async () => {
    await fs.writeFile(path.join(dir, "project/src/old.ts"), "");
    await fs.utimes(path.join(dir, "project/src/old.ts"), new Date(2000, 0, 1), new Date(2000, 0, 1));
    await fs.writeFile(path.join(dir, "project/src/new.ts"), "");
    const out = (await glob.run({ pattern: "src/*.ts" }, ctx())).split("\n");
    expect(out.indexOf("src/new.ts")).toBeLessThan(out.indexOf("src/old.ts"));
  });

  test("grep can list files or count matches instead of lines", async () => {
    await fs.writeFile(path.join(dir, "project/src/b.ts"), "export const b = 1;\nexport const c = 2;\n");
    expect(await grep.run({ pattern: "export", output_mode: "files_with_matches" }, ctx())).toContain("src/b.ts");
    expect(await grep.run({ pattern: "export", output_mode: "count" }, ctx())).toMatch(/src\/b\.ts:2/);
  });
});

describe("background shells", () => {
  test("run_in_background returns at once; bash_output reads it, kill_shell stops it", async () => {
    const started = await bash.run({ command: "echo started; sleep 30", run_in_background: true }, ctx());
    const id = /as (\S+) \(pid/.exec(started)?.[1];
    expect(id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(await bashOutput.run({ shell_id: id! }, ctx())).toContain("started");
    expect(await killShell.run({ shell_id: id! }, ctx())).toContain("stopped");
  }, 10_000);
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
    await expect(editFile.run({ path: "src/a.ts", old_string: "a = 2", new_string: "a = 3" }, c)).rejects.toThrow("changed on disk");
  });

  test("write_file won't overwrite a file the agent never read", async () => {
    const c = { ...ctx(), files: new Map<string, string>() };
    await expect(writeFile.run({ path: "src/a.ts", content: "x" }, c)).rejects.toThrow("Read it first");
    await readFile.run({ path: "src/a.ts" }, c);
    expect(await writeFile.run({ path: "src/a.ts", content: "x" }, c)).toContain("Updated src/a.ts");
    expect(await writeFile.run({ path: "src/new.ts", content: "y" }, c)).toContain("Created src/new.ts (1 line)");
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
