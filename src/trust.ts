import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Folder trust, like other coding agents: the first time ngobe opens in a folder it asks whether
 * the user trusts its files (AGENTS.md and custom agents there go into the model's context, and
 * the agent may run its scripts). Trusting a folder trusts everything below it, except that
 * trusting your home directory or / covers only that exact directory.
 */

function trustFile(stateDir: string): string {
  return path.join(stateDir, "trusted-folders.json");
}

function load(stateDir: string): string[] {
  try {
    const list = JSON.parse(fs.readFileSync(trustFile(stateDir), "utf8"));
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function real(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

const broad = (dir: string) => dir === path.parse(dir).root || dir === real(os.homedir());

export function isTrusted(dir: string, stateDir: string): boolean {
  const target = real(dir);
  return load(stateDir).some((t) => t === target || (!broad(t) && target.startsWith(t.endsWith(path.sep) ? t : t + path.sep)));
}

export function trustFolder(dir: string, stateDir: string): void {
  const list = load(stateDir);
  const target = real(dir);
  if (list.includes(target)) return;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(trustFile(stateDir), JSON.stringify([...list, target], null, 2) + "\n", { mode: 0o600 });
}
