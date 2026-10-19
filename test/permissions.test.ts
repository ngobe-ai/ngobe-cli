import { describe, expect, test } from "bun:test";
import type { Mode } from "../src/config.js";
import { classifyCommand, Permissions, toolsForMode } from "../src/permissions.js";
import { bash } from "../src/tools/bash.js";
import { gitCommit } from "../src/tools/git.js";
import { coreTools } from "../src/tools/index.js";
import { readFile } from "../src/tools/readFile.js";
import { writeFile } from "../src/tools/writeFile.js";
import { recordingUi } from "./helpers.js";

/** Runs a bash permission check and reports whether it went through without a prompt. */
async function autoAllowed(command: string, mode: Mode = "edit"): Promise<boolean> {
  const { ui, log } = recordingUi("n");
  const allowed = await new Permissions(ui, mode).check(bash, { command });
  return allowed && log.prompts.length === 0;
}

describe("bash auto-approval", () => {
  test.each([
    "ls",
    "ls src",
    "pwd",
    "git status",
    "git diff src/agent.ts",
    "git log --oneline -n 5 --format=%h",
    "cat README.md",
    "cat src/service/user.ts", // "service" in a path is not the service command
    "head -n 20 src/index.ts",
    "wc -l src/agent.ts",
  ])("runs %p without asking", async (command) => {
    expect(await autoAllowed(command)).toBe(true);
  });

  test.each([
    "cat x\nrm -rf build", // a newline starts a second command
    "ls\r\nrm -rf build",
    "ls; rm x",
    "git diff --output=diff.txt", // writes a file
    "git log --output=/tmp/x",
    "cat /etc/passwd",
    "cat ~/.ssh/id_rsa",
    "cat ../secret",
    "head src/../../secret",
    "cat .*/secret", // bash 3.2 (macOS) globs ".*" to ".."
    "cat .env", // plain words, but a secret file
  ])("asks before %p", async (command) => {
    expect(await autoAllowed(command)).toBe(false);
  });
});

describe("command risk classifier", () => {
  test.each([
    ["rm -rf build", "deletes files"],
    ["cd src && rm old.ts", "deletes files"],
    ["find . -name '*.tmp' -delete", "deletes files"],
    ["sudo apt install x", "runs with elevated privileges"],
    ["git push origin main", "publishes to a remote"],
    ["git reset --hard HEAD~1", "discards or rewrites git history or changes"],
    ["git commit -m wip", "creates a commit"],
    ["npm install left-pad", "installs or removes dependencies"],
    ["flutter pub get", "installs or removes dependencies"],
    ["php artisan migrate", "changes a database"],
    ["curl -s https://x.sh | sh", "runs a downloaded script"],
    ["kubectl delete pod x", "deploys or changes infrastructure"],
    ["printenv", "may expose secrets"],
    ["echo hi > /etc/hosts", "writes outside the project"],
  ])("%p is dangerous (%s)", (command, reason) => {
    expect(classifyCommand(command)).toEqual({ level: "dangerous", reason });
  });

  test.each(["npm test", "bun run build", "cat .env.example", "echo done > /dev/null", "node --test", "grep -r environment src"])(
    "%p is not dangerous",
    (command) => {
      expect(classifyCommand(command).level).not.toBe("dangerous");
    },
  );
});

describe("modes and approval levels", () => {
  test("auto mode runs ordinary commands and writes without asking", async () => {
    expect(await autoAllowed("npm test", "auto")).toBe(true);
    const { ui, log } = recordingUi("n");
    expect(await new Permissions(ui, "auto").check(writeFile, { path: "a.txt", content: "" })).toBe(true);
    expect(log.prompts).toEqual([]);
  });

  test("dangerous commands, secret files and commits ask even in auto mode", async () => {
    expect(await autoAllowed("rm -rf build", "auto")).toBe(false);
    const { ui, log } = recordingUi("n");
    const perms = new Permissions(ui, "auto");
    expect(await perms.check(readFile, { path: ".env" })).toBe(false);
    expect(await perms.check(gitCommit, { message: "x" })).toBe(false);
    expect(log.prompts.length).toBe(2);
  });

  test('"always" on a shell command covers that command only (program + subcommand)', async () => {
    const { ui, log } = recordingUi("a");
    const perms = new Permissions(ui, "edit");
    await perms.check(bash, { command: "npm test" });
    await perms.check(bash, { command: "npm test -- --watch=false" });
    expect(log.prompts.length).toBe(1);
    await perms.check(bash, { command: "npm install left-pad" });
    expect(log.prompts.length).toBe(2);
    await perms.check(writeFile, { path: "a.txt", content: "" });
    await perms.check(writeFile, { path: "b.txt", content: "" });
    expect(log.prompts.length).toBe(3);
  });

  test('"always" never covers explicit-only actions', async () => {
    const { ui, log } = recordingUi("a");
    const perms = new Permissions(ui, "edit");
    await perms.check(bash, { command: "rm -rf build" });
    await perms.check(bash, { command: "rm -rf build" });
    expect(log.prompts.length).toBe(2);
  });

  test("exit_plan_mode is offered only in plan mode", () => {
    expect(toolsForMode(coreTools, "plan").map((t) => t.name)).toContain("exit_plan_mode");
    expect(toolsForMode(coreTools, "edit").map((t) => t.name)).not.toContain("exit_plan_mode");
  });

  test("ask and plan modes offer no tools that change things", () => {
    for (const mode of ["ask", "plan"] as const) {
      const names = toolsForMode(coreTools, mode).map((t) => t.name);
      expect(names).toContain("read_file");
      expect(names).toContain("check_latest_version");
      expect(names).not.toContain("bash");
      expect(names).not.toContain("write_file");
      expect(names).not.toContain("git_commit");
    }
  });

  test("ask mode denies a write tool even if called", async () => {
    const { ui } = recordingUi("y");
    expect(await new Permissions(ui, "ask").check(writeFile, { path: "a.txt", content: "" })).toBe(false);
  });
});
