import { createRequire } from "node:module";

export type Param = string | number | null;

/** The few SQLite operations the memory store needs, over bun:sqlite or node:sqlite. */
export interface Db {
  exec(sql: string): void;
  run(sql: string, ...params: Param[]): void;
  get<T>(sql: string, ...params: Param[]): T | undefined;
  all<T>(sql: string, ...params: Param[]): T[];
  close(): void;
}

interface Statement {
  run(...params: Param[]): unknown;
  get(...params: Param[]): unknown;
  all(...params: Param[]): unknown[];
}

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

const require = createRequire(import.meta.url);

/**
 * Open (or create) a SQLite database with whichever driver the runtime ships: bun:sqlite
 * under Bun, node:sqlite under Node 22.13+. No native dependency to install.
 */
export function openDb(file: string): Db {
  let raw: RawDb;
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    const { Database } = require("bun:sqlite") as { Database: new (f: string, o?: object) => RawDb };
    raw = new Database(file, { create: true });
  } else {
    // node:sqlite prints an ExperimentalWarning on load in Node 22; it is stable enough for this.
    const emit = process.emitWarning;
    process.emitWarning = ((w: string | Error, ...rest: unknown[]) =>
      String(typeof w === "string" ? w : w.message).includes("SQLite") ? undefined : (emit as (...a: unknown[]) => void).call(process, w, ...rest)) as typeof process.emitWarning;
    try {
      const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (f: string) => RawDb };
      raw = new DatabaseSync(file);
    } finally {
      process.emitWarning = emit;
    }
  }

  const cache = new Map<string, Statement>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = raw.prepare(sql)));
    return s;
  };
  return {
    exec: (sql) => raw.exec(sql),
    run: (sql, ...params) => void stmt(sql).run(...params),
    get: <T>(sql: string, ...params: Param[]) => (stmt(sql).get(...params) ?? undefined) as T | undefined,
    all: <T>(sql: string, ...params: Param[]) => stmt(sql).all(...params) as T[],
    close: () => raw.close(),
  };
}
