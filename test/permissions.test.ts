import { describe, expect, test } from "bun:test";
import { Permissions } from "../src/permissions.js";
import { bash } from "../src/tools/bash.js";
import type { Ui } from "../src/ui.js";

/** Runs a bash permission check and reports whether it went through without a prompt. */
async function autoAllowed(command: string): Promise<boolean> {
  let asked = false;
  const ui = {
    confirm: async () => {
      asked = true;
      return "n";
    },
  } as unknown as Ui;
  await new Permissions(ui, false).check(bash, { command });
  return !asked;
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
  ])("asks before %p", async (command) => {
    expect(await autoAllowed(command)).toBe(false);
  });
});
