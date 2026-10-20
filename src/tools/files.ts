import { execFile, spawn, spawnSync } from "node:child_process";
import fg from "fast-glob";
import { childEnv } from "../childEnv.js";

/** Never listed: VCS data and dependency trees, even when no .gitignore says so. */
const ALWAYS_SKIPPED = [".git", "node_modules"];
/** Without ripgrep or git: build output and caches that a .gitignore would normally hide. */
const SKIPPED_WITHOUT_GITIGNORE = [...ALWAYS_SKIPPED, "dist", "build", "target", ".dart_tool", ".gradle", "Pods", ".next", ".venv", "venv", "__pycache__", "vendor", "coverage", ".cache", ".idea"];
/** Enough for any project; a home directory or / is cut off here. */
const MAX_FILES = 200_000;

let rgAvailable: boolean | undefined;
export function hasRipgrep(): boolean {
  rgAvailable ??= spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  return rgAvailable;
}

/**
 * Every file under dir, relative to it, the way the project sees it: .gitignored files (in nested
 * repositories too), .git and node_modules are left out. ripgrep when installed, else git, else a
 * walk that skips the usual build and cache folders. Symbolic links are not followed.
 */
export async function listFiles(dir: string, signal?: AbortSignal): Promise<string[]> {
  if (hasRipgrep()) return ripgrepFiles(dir, signal);
  const tracked = await gitFiles(dir, signal);
  if (tracked) return tracked;
  const files = await fg("**/*", { cwd: dir, dot: true, ignore: SKIPPED_WITHOUT_GITIGNORE.map((d) => `**/${d}/**`), followSymbolicLinks: false });
  return files.slice(0, MAX_FILES);
}

function ripgrepFiles(dir: string, signal?: AbortSignal): Promise<string[]> {
  const args = ["--files", "--hidden", "--no-messages", ...ALWAYS_SKIPPED.flatMap((d) => ["--glob", `!${d}`])];
  return new Promise((resolve) => {
    const child = spawn("rg", args, { cwd: dir, signal, env: childEnv(), stdio: ["ignore", "pipe", "ignore"] });
    const files: string[] = [];
    let rest = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) if (l) files.push(l.replace(/^\.\//, ""));
      if (files.length >= MAX_FILES) child.kill();
    });
    child.on("error", () => resolve(files));
    child.on("close", () => {
      if (rest) files.push(rest.replace(/^\.\//, ""));
      resolve(files.slice(0, MAX_FILES));
    });
  });
}

/** Tracked and untracked-but-not-ignored files when dir is inside a git work tree, else null. */
function gitFiles(dir: string, signal?: AbortSignal): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: dir, signal, env: childEnv(), maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const skipped = (f: string) => f.split("/").some((part) => ALWAYS_SKIPPED.includes(part));
        resolve([...new Set(stdout.split("\0").filter((f) => f && !skipped(f)))].slice(0, MAX_FILES));
      },
    );
  });
}
