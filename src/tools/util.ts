import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Args, ToolContext } from "../types.js";

/** True if p (relative to cwd, or absolute) is cwd or somewhere below it. */
export function isInside(cwd: string, p: string): boolean {
  const rel = path.relative(cwd, path.resolve(cwd, p));
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/**
 * Resolve a user/model-supplied path and refuse anything outside the project directory,
 * following symbolic links (a cloned repo can contain notes.txt -> ~/.ssh/id_rsa), and
 * refuse innocent names that link to secret files.
 */
export function resolveInside(cwd: string, p: unknown): string {
  if (typeof p !== "string" || !p) throw new Error('argument "path" must be a non-empty string');
  // Compared with links resolved on both sides: a project opened through a link (macOS /var is
  // /private/var) is entered by its real path too, and a link inside it can't lead out.
  const abs = path.resolve(cwd, p);
  const real = realPath(abs);
  const root = realPath(cwd);
  if (!isInside(root, real)) {
    throw new Error(isInside(cwd, p) ? `path is outside the project directory (through a symbolic link): ${p}` : `path is outside the project directory: ${p}`);
  }
  if (isSecretPath(path.relative(root, real)) && !isSecretPath(p)) {
    throw new Error(`${p} is a link to a secret file (${path.relative(root, real)}); use that name, which needs explicit approval`);
  }
  // One name per file (under the project root as opened), so read-before-edit tracking matches.
  return isInside(cwd, p) ? abs : path.join(path.resolve(cwd), path.relative(root, real));
}

/** "~/Downloads/a.pdf" → an absolute path. */
export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Whether a path the model gave names a place outside the project (as written, before links). */
export function isOutsideProject(cwd: string, p: string): boolean {
  const root = path.resolve(cwd);
  const rel = path.relative(root, path.resolve(root, expandHome(p)));
  return rel.startsWith("..") || path.isAbsolute(rel);
}

/**
 * A path read_file may read: inside the project as resolveInside allows, or a file outside it the
 * user pointed at (~/Downloads/report.pdf; the permission check saw it in the request or asked).
 * A path written inside the project that leads out through a link is still refused.
 */
export function resolveReadable(cwd: string, p: unknown): string {
  if (typeof p !== "string" || !p) throw new Error('argument "path" must be a non-empty string');
  const expanded = expandHome(p);
  return isOutsideProject(cwd, expanded) ? path.resolve(cwd, expanded) : resolveInside(cwd, expanded);
}

/** Whether the user's request names this file: as written, absolute, with ~, or by a distinctive file name. */
export function mentionsPath(request: string, p: string): boolean {
  const said = request.replace(/\\ /g, " ").toLowerCase();
  const abs = path.resolve(expandHome(p)).toLowerCase();
  const home = os.homedir().toLowerCase();
  const tilde = abs.startsWith(home + path.sep) ? `~${abs.slice(home.length)}` : abs;
  const base = path.basename(abs);
  return [p.toLowerCase(), abs, tilde].some((x) => said.includes(x)) || (base.length >= 5 && base.includes(".") && said.includes(base));
}

/** Real path with links resolved; for a path that doesn't exist yet, its nearest existing parent's. */
function realPath(abs: string): string {
  const rest: string[] = [];
  for (let cur = abs; ; cur = path.dirname(cur)) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      if (path.dirname(cur) === cur) return abs;
      rest.push(path.basename(cur));
    }
  }
}

const SECRET_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
]);
const SECRET_EXT = /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i;
const ENV_FILE = /^\.env(\.[\w.-]+)?$/;
const ENV_TEMPLATE = /\.(example|sample|template|dist)$/;

/**
 * Files that commonly hold credentials: reading or writing one needs explicit approval, and
 * grep skips them. Case-insensitive, since .ENV is the same file as .env on macOS and Windows.
 */
export function isSecretPath(p: string): boolean {
  const lower = p.toLowerCase();
  const base = path.basename(lower);
  if (ENV_FILE.test(base)) return !ENV_TEMPLATE.test(base);
  const dirs = lower.split(/[\\/]/);
  return SECRET_NAMES.has(base) || SECRET_EXT.test(base) || dirs.includes(".ssh") || dirs.includes(".aws");
}

/** Paths inside a .git directory: hooks and config there can run commands. */
export function isGitInternal(p: string): boolean {
  return p.split(/[\\/]/).includes(".git");
}

export function hashText(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex");
}

/** Refuse to write over a file that changed since the agent last read or wrote it. */
export function assertUnchanged(ctx: ToolContext, abs: string, current: string, shown: string): void {
  const seen = ctx.files?.get(abs);
  if (seen !== undefined && seen !== hashText(current)) {
    throw new Error(`${shown} changed on disk since you last read it (edited by someone else?). Read it again first.`);
  }
}

export function reqStr(args: Args, key: string, allowEmpty = false): string {
  const v = args[key];
  if (typeof v !== "string" || (!allowEmpty && v.length === 0)) {
    throw new Error(`argument "${key}" must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return v;
}

/** Small models often send numbers as strings, so coerce. */
export function optInt(args: Args, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`argument "${key}" must be a number`);
  return Math.floor(n);
}
