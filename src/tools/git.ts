import { execFile } from "node:child_process";
import { childEnv } from "../childEnv.js";
import type { Args, Need, Tool, ToolContext } from "../types.js";
import { isSecretPath, optInt, reqStr, resolveInside } from "./util.js";

const MAX_OUTPUT = 200_000;

/**
 * Run git without a shell. Throws with git's stderr on failure. Read-only calls disable
 * core.fsmonitor, which a planted .git/config could point at any program.
 */
export function git(args: string[], ctx: ToolContext, timeoutMs = 30_000, readOnly = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      readOnly ? ["-c", "core.fsmonitor=false", ...args] : args,
      { cwd: ctx.cwd, signal: ctx.signal, timeout: timeoutMs, maxBuffer: MAX_OUTPUT * 4, env: childEnv() },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) + "\n[output truncated]" : stdout);
      },
    );
  });
}

// A revision or range like HEAD~2, main, v1.2.0..HEAD, origin/main. Never starts with "-" (no option injection).
const REF = /^(?!-)[\w./~^@{}-]+(\.\.\.?[\w./~^@{}-]+)?$/;

function ref(v: unknown): string | undefined {
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string" || !REF.test(v)) throw new Error(`invalid git ref: ${v}`);
  return v;
}

// Secret files never appear in diffs (a tracked .env would otherwise be printed in full).
const SECRET_EXCLUDES = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "id_rsa*", "id_ed25519*", "credentials*", ".npmrc", ".netrc", ".pypirc", ".git-credentials"].map(
  (g) => `:(exclude,glob,icase)**/${g}`,
);

function pathspec(ctx: ToolContext, v: unknown, excludeSecrets = false): string[] {
  const excludes = excludeSecrets ? SECRET_EXCLUDES : [];
  if (v === undefined || v === "") return excludeSecrets ? ["--", ".", ...excludes] : [];
  resolveInside(ctx.cwd, v);
  return ["--", String(v), ...excludes];
}

const secretPathNeeds = (a: Args): Need => (typeof a.path === "string" && isSecretPath(a.path) ? "explicit" : "none");

export const gitStatus: Tool = {
  name: "git_status",
  label: "Git",
  target: () => "status",
  activity: () => "Checking git status",
  summarize: (_a, output) => {
    const changed = output.split("\n").filter((l) => l && !l.startsWith("##")).length;
    return { summary: changed ? `${changed} changed file${changed === 1 ? "" : "s"}` : "Clean working tree" };
  },
  description: "Show the current branch and changed files (git status --short --branch).",
  parameters: { type: "object", properties: {} },
  risk: "safe",
  describe: () => "git status",
  async run(_args, ctx) {
    return (await git(["status", "--short", "--branch"], ctx, 30_000, true)) || "Clean working tree.";
  },
};

export const gitDiff: Tool = {
  name: "git_diff",
  label: "Git",
  target: (a) => `diff${a.staged ? " --staged" : ""}${a.ref ? ` ${a.ref}` : ""}${a.path ? ` ${a.path}` : ""}`,
  activity: () => "Reading the diff",
  summarize: (_a, output) => {
    const files = (output.match(/^diff --git /gm) ?? []).length;
    const add = (output.match(/^\+(?!\+\+)/gm) ?? []).length;
    const del = (output.match(/^-(?!--)/gm) ?? []).length;
    return { summary: files ? `${files} file${files === 1 ? "" : "s"} · +${add} −${del}` : "No differences" };
  },
  description:
    "Show a diff: uncommitted changes by default, staged changes with staged=true, or changes since a ref (e.g. main, HEAD~3).",
  lean: {
    description: "Uncommitted changes as a diff; staged=true for staged ones, ref (e.g. main) for changes since then.",
    parameters: { type: "object", properties: { ref: { type: "string" }, staged: { type: "boolean" }, path: { type: "string" } } },
  },
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Compare the working tree with this revision or range" },
      staged: { type: "boolean" },
      path: { type: "string", description: "Limit to this file or directory" },
    },
  },
  risk: "safe",
  needs: secretPathNeeds,
  describe: (a) => `git diff${a.staged ? " --staged" : ""}${a.ref ? " " + a.ref : ""}${a.path ? " -- " + a.path : ""}`,
  async run(args, ctx) {
    const argv = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
    if (args.staged) argv.push("--staged");
    const r = ref(args.ref);
    if (r) argv.push(r);
    argv.push(...pathspec(ctx, args.path, !(typeof args.path === "string" && isSecretPath(args.path))));
    return (await git(argv, ctx, 30_000, true)) || "No differences.";
  },
};

export const gitLog: Tool = {
  name: "git_log",
  label: "Git",
  target: (a) => `log${a.ref ? ` ${a.ref}` : ""}${a.path ? ` ${a.path}` : ""}`,
  activity: () => "Reading the history",
  summarize: (_a, output) => ({ summary: `${output.split("\n").filter(Boolean).length} commits` }),
  description: "Show recent commits (one line each), optionally for a ref or path.",
  parameters: {
    type: "object",
    properties: {
      count: { type: "integer", description: "Default 20", minimum: 1, maximum: 200 },
      ref: { type: "string" },
      path: { type: "string" },
    },
  },
  risk: "safe",
  needs: secretPathNeeds,
  describe: (a) => `git log${a.ref ? " " + a.ref : ""}${a.path ? " -- " + a.path : ""}`,
  async run(args, ctx) {
    const argv = ["log", "--oneline", "--no-color", "-n", String(optInt(args, "count") ?? 20)];
    const r = ref(args.ref);
    if (r) argv.push(r);
    argv.push(...pathspec(ctx, args.path));
    return (await git(argv, ctx, 30_000, true)) || "No commits.";
  },
};

export const gitBranchCreate: Tool = {
  name: "git_branch_create",
  label: "Git",
  target: (a) => `switch -c ${a.name}`,
  activity: (a) => `Creating branch ${a.name}`,
  summarize: (_a, output) => ({ summary: output.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "" }),
  description: "Create a new branch from the current HEAD and switch to it.",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  risk: "write",
  describe: (a) => `git switch -c ${a.name}`,
  async run(args, ctx) {
    const name = reqStr(args, "name");
    await git(["check-ref-format", "--branch", name], ctx).catch(() => {
      throw new Error(`invalid branch name: ${name}`);
    });
    await git(["switch", "-c", name], ctx);
    return `Created and switched to branch ${name}.`;
  },
};

export const gitCommit: Tool = {
  name: "git_commit",
  label: "Git",
  target: (a) => `commit "${String(a.message ?? "").split("\n")[0].slice(0, 50)}"`,
  activity: () => "Committing",
  summarize: (_a, output) => ({ summary: output.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "" }),
  description:
    "Commit changes. Stages the given paths first (or commits what is already staged). Never pushes. Always asks the user.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string" },
      paths: { type: "array", items: { type: "string" }, description: "Files to stage before committing" },
    },
    required: ["message"],
  },
  risk: "write",
  needs: () => "explicit",
  describe: (a) => `git commit -m ${JSON.stringify(String(a.message ?? "").split("\n")[0])}`,
  async run(args, ctx) {
    const message = reqStr(args, "message");
    const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
    for (const p of paths) resolveInside(ctx.cwd, p);
    if (paths.length) await git(["add", "--", ...paths], ctx);
    return await git(["commit", "-m", message], ctx, 120_000); // hooks may run
  },
};

export const gitTools = [gitStatus, gitDiff, gitLog, gitBranchCreate, gitCommit];
