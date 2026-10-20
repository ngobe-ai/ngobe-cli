import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import { containsSecret, redact } from "../log.js";
import { clusterFailures, signature, type Cluster, type FailureRow } from "./cluster.js";
import { openDb, type Db } from "./db.js";

/** "lesson": how a tool call that failed was fixed, learned from runs; global (project "*"). */
export type FactKind = "command" | "convention" | "version" | "source" | "note" | "lesson";

export interface Fact {
  id: number;
  /** Project root, or "*" for facts that apply everywhere. */
  project: string;
  kind: FactKind;
  key: string;
  value: string;
  /** agent = the model asked to remember it; observed = learned from a run's results; user. */
  source: string;
  confidence: number;
  created_at: string;
  updated_at: string;
  /** After this the fact is ignored until confirmed again (version facts go stale). */
  expires_at: string | null;
  uses: number;
}

export interface RunRecord {
  id: string;
  project: string;
  command: string;
  mode: string;
  model: string;
  variant: string;
  started_at: string;
  duration_ms: number;
  model_ms: number;
  tool_ms: number;
  turns: number;
  tool_calls: number;
  tool_errors: number;
  tokens_in: number;
  tokens_out: number;
  tokens_estimated: number;
  /** completed | limit | cancelled | error */
  outcome: string;
  /** passed | failed, when the run executed tests; null otherwise. */
  tests: string | null;
}

export interface DocHit {
  url: string;
  title: string;
  tech: string;
  fetched_at: string;
  snippet: string;
}

export interface Variant {
  name: string;
  prompt: string;
  created_at: string;
  source: string;
  score: number | null;
  results: string | null;
}

const SCHEMA = `
create table if not exists meta(key text primary key, value text);
create table if not exists facts(
  id integer primary key, project text not null, kind text not null, key text not null, value text not null,
  source text not null, confidence real not null default 0.5, created_at text not null, updated_at text not null,
  expires_at text, uses integer not null default 0, unique(project, kind, key));
create table if not exists runs(
  id text primary key, project text, command text, mode text, model text, variant text, started_at text,
  duration_ms integer, model_ms integer, tool_ms integer, turns integer, tool_calls integer, tool_errors integer,
  tokens_in integer, tokens_out integer, tokens_estimated integer, outcome text, tests text);
create table if not exists tool_events(run_id text, tool text, ok integer, error_class text, duration_ms integer, at text);
create index if not exists tool_events_at on tool_events(at);
create table if not exists failures(id integer primary key, run_id text, project text, tool text, signature text, sample text, at text);
create index if not exists failures_at on failures(at);
create virtual table if not exists docs using fts5(title, body, url unindexed, tech unindexed, fetched_at unindexed, tokenize='porter unicode61');
create table if not exists variants(name text primary key, prompt text, created_at text, source text, score real, results text);
`;

const now = () => new Date().toISOString();

/**
 * Experience memory in one SQLite file: facts with provenance, confidence and expiry,
 * run outcomes, tool reliability, failure history, a local index of fetched official
 * docs, and prompt variants. Holds no source files, conversations or secrets.
 */
export class Memory {
  private constructor(
    private db: Db,
    readonly file: string,
  ) {}

  /** null when memory is turned off or SQLite isn't available (the agent works without it). */
  static open(config: Config, onError?: (msg: string) => void): Memory | null {
    if (!config.memory) return null;
    const file = path.join(config.stateDir, "ngobe.db");
    try {
      fs.mkdirSync(config.stateDir, { recursive: true });
      const db = openDb(file);
      // Two ngobe processes may share the file: wait for locks instead of failing, and let readers run alongside a writer.
      db.exec("PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL;");
      db.exec(SCHEMA);
      return new Memory(db, file);
    } catch (err) {
      onError?.(`memory unavailable (${err instanceof Error ? err.message : String(err)}); continuing without it`);
      return null;
    }
  }

  close(): void {
    this.db.close();
  }

  // --- switches ---------------------------------------------------------------

  /** Recording and recall pause while disabled; existing data is kept. */
  get enabled(): boolean {
    return this.meta("disabled") !== "1";
  }

  setEnabled(on: boolean): void {
    this.setMeta("disabled", on ? "0" : "1");
  }

  meta(key: string): string | undefined {
    return this.db.get<{ value: string }>("select value from meta where key = ?", key)?.value;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.run("delete from meta where key = ?", key);
    else this.db.run("insert into meta(key, value) values(?, ?) on conflict(key) do update set value = excluded.value", key, value);
  }

  // --- facts ------------------------------------------------------------------

  /**
   * Store or reinforce a fact. Repeating the same value raises confidence; a different
   * value replaces it at the given confidence. Values that look like credentials are refused.
   */
  remember(f: { project: string; kind: FactKind; key: string; value: string; source: string; confidence?: number; ttlDays?: number }): Fact {
    if (containsSecret(f.value) || containsSecret(f.key)) throw new Error("refusing to store something that looks like a credential");
    const value = f.value.slice(0, 500);
    const expires = f.ttlDays ? new Date(Date.now() + f.ttlDays * 86_400_000).toISOString() : null;
    const existing = this.db.get<Fact>("select * from facts where project = ? and kind = ? and key = ?", f.project, f.kind, f.key);
    if (existing && existing.value === value) {
      this.db.run(
        "update facts set confidence = min(1.0, confidence + 0.1), updated_at = ?, expires_at = ? where id = ?",
        now(),
        expires,
        existing.id,
      );
    } else {
      this.db.run(
        `insert into facts(project, kind, key, value, source, confidence, created_at, updated_at, expires_at)
         values(?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(project, kind, key) do update set value = excluded.value, source = excluded.source,
           confidence = excluded.confidence, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
        f.project,
        f.kind,
        f.key,
        value,
        f.source,
        f.confidence ?? 0.5,
        now(),
        now(),
        expires,
      );
    }
    return this.db.get<Fact>("select * from facts where project = ? and kind = ? and key = ?", f.project, f.kind, f.key)!;
  }

  /** Lower confidence after a fact turned out wrong (e.g. a remembered command failed); drop it at zero. */
  weaken(project: string, kind: FactKind, key: string, by = 0.3): void {
    this.db.run("update facts set confidence = confidence - ?, updated_at = ? where project = ? and kind = ? and key = ?", by, now(), project, kind, key);
    this.db.run("delete from facts where confidence <= 0");
  }

  /** Unexpired facts for a project (plus global ones), most trusted first. */
  recall(project: string, limit = 12, kinds?: FactKind[]): Fact[] {
    const facts = this.db.all<Fact>(
      `select * from facts where project in (?, '*') and (expires_at is null or expires_at > ?)
       order by confidence desc, updated_at desc limit ?`,
      project,
      now(),
      kinds ? 200 : limit,
    );
    return kinds ? facts.filter((f) => kinds.includes(f.kind)).slice(0, limit) : facts;
  }

  markUsed(ids: number[]): void {
    for (const id of ids) this.db.run("update facts set uses = uses + 1 where id = ?", id);
  }

  listFacts(project?: string): Fact[] {
    return project
      ? this.db.all<Fact>("select * from facts where project in (?, '*') order by project, kind, key", project)
      : this.db.all<Fact>("select * from facts order by project, kind, key");
  }

  getFact(id: number): Fact | undefined {
    return this.db.get<Fact>("select * from facts where id = ?", id);
  }

  deleteFact(id: number): boolean {
    const had = !!this.getFact(id);
    this.db.run("delete from facts where id = ?", id);
    return had;
  }

  /** Delete everything learned (facts, runs, failures, docs index); prompt variants are kept. */
  clear(): void {
    this.db.exec("delete from facts; delete from runs; delete from tool_events; delete from failures; delete from docs;");
  }

  // --- runs and outcomes --------------------------------------------------------

  recordRun(r: RunRecord): void {
    this.db.run(
      `insert or replace into runs values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      r.project,
      r.command,
      r.mode,
      r.model,
      r.variant,
      r.started_at,
      r.duration_ms,
      r.model_ms,
      r.tool_ms,
      r.turns,
      r.tool_calls,
      r.tool_errors,
      r.tokens_in,
      r.tokens_out,
      r.tokens_estimated,
      r.outcome,
      r.tests,
    );
  }

  recordToolEvent(runId: string, tool: string, ok: boolean, errorClass: string | null, durationMs: number): void {
    this.db.run("insert into tool_events values(?, ?, ?, ?, ?, ?)", runId, tool, ok ? 1 : 0, errorClass, durationMs, now());
  }

  recordFailure(runId: string, project: string, tool: string, raw: string): void {
    const message = redact(raw); // error text often quotes the command, which may carry a token
    this.db.run(
      "insert into failures(run_id, project, tool, signature, sample, at) values(?, ?, ?, ?, ?, ?)",
      runId,
      project,
      tool,
      signature(message),
      message.slice(0, 300),
      now(),
    );
  }

  recentRuns(limit = 20): RunRecord[] {
    return this.db.all<RunRecord>("select * from runs order by started_at desc limit ?", limit);
  }

  /** Recurring failures over the last `days`, optionally for one project. */
  failureClusters(days = 30, project?: string): Cluster[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const rows = project
      ? this.db.all<FailureRow>("select signature, sample, tool, at from failures where at > ? and project = ? order by at", since, project)
      : this.db.all<FailureRow>("select signature, sample, tool, at from failures where at > ? order by at", since);
    return clusterFailures(rows);
  }

  toolStats(days = 30): { tool: string; calls: number; ok_rate: number; avg_ms: number }[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db.all(
      `select tool, count(*) calls, round(avg(ok), 3) ok_rate, cast(avg(duration_ms) as integer) avg_ms
       from tool_events where at > ? group by tool order by calls desc`,
      since,
    );
  }

  runStats(days = 30): { runs: number; completed: number; tests_passed: number; tests_failed: number; avg_ms: number; avg_model_ms: number; avg_tool_ms: number } {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    return this.db.get(
      `select count(*) runs, coalesce(sum(outcome = 'completed'), 0) completed,
         coalesce(sum(tests = 'passed'), 0) tests_passed, coalesce(sum(tests = 'failed'), 0) tests_failed,
         coalesce(cast(avg(duration_ms) as integer), 0) avg_ms, coalesce(cast(avg(model_ms) as integer), 0) avg_model_ms,
         coalesce(cast(avg(tool_ms) as integer), 0) avg_tool_ms
       from runs where started_at > ?`,
      since,
    )!;
  }

  // --- local index of fetched official docs ---------------------------------------

  /** Replace a page in the docs index, split into ~1500-character chunks at paragraph breaks. */
  indexDoc(url: string, title: string, text: string, tech: string, fetchedAt: string): void {
    this.db.run("delete from docs where url = ?", url);
    for (const chunk of chunks(text, 1500)) this.db.run("insert into docs values(?, ?, ?, ?, ?)", title, chunk, url, tech, fetchedAt);
  }

  /** Full-text search (BM25) over previously fetched official pages. */
  searchDocs(query: string, tech?: string, limit = 5): DocHit[] {
    const terms = query.match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
    if (terms.length === 0) return [];
    const match = terms.map((t) => `"${t}"`).join(" OR ");
    const rows = this.db.all<DocHit>(
      `select url, title, tech, fetched_at, snippet(docs, 1, '', '', '…', 40) snippet from docs
       where docs match ? ${tech ? "and tech = ?" : ""} order by bm25(docs) limit ?`,
      ...(tech ? [match, tech, limit] : [match, limit]),
    );
    const seen = new Set<string>();
    return rows.filter((r) => !seen.has(r.url) && seen.add(r.url));
  }

  docsCount(): number {
    return this.db.get<{ n: number }>("select count(distinct url) n from docs")?.n ?? 0;
  }

  // --- prompt variants ------------------------------------------------------------

  saveVariant(name: string, prompt: string, source: string): void {
    if (!/^[\w.-]{1,40}$/.test(name)) throw new Error("variant names are letters, digits, . _ - (max 40)");
    this.db.run(
      "insert into variants values(?, ?, ?, ?, null, null) on conflict(name) do update set prompt = excluded.prompt, source = excluded.source, score = null, results = null",
      name,
      prompt,
      now(),
      source,
    );
  }

  variant(name: string): Variant | undefined {
    return this.db.get<Variant>("select * from variants where name = ?", name);
  }

  variants(): Variant[] {
    return this.db.all<Variant>("select * from variants order by created_at");
  }

  setVariantScore(name: string, score: number, results: unknown): void {
    this.db.run("update variants set score = ?, results = ? where name = ?", score, JSON.stringify(results), name);
  }
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n{2,}/)) {
    if (cur && cur.length + para.length > size) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${para}` : para;
    while (cur.length > size * 2) {
      out.push(cur.slice(0, size));
      cur = cur.slice(size);
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}
