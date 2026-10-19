import path from "node:path";
import type { Args } from "../types.js";

/** Resolve a user/model-supplied path and refuse anything outside the project directory. */
export function resolveInside(cwd: string, p: unknown): string {
  if (typeof p !== "string" || !p) throw new Error('argument "path" must be a non-empty string');
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path is outside the project directory: ${p}`);
  }
  return abs;
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
