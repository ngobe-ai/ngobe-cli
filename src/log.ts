import fs from "node:fs";
import path from "node:path";

const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\btvly-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];
// key=value / key: value where the key names a secret; the value is replaced, the key kept.
const SECRET_ASSIGNMENT = /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;

/** Replace credentials and key=value secrets with [redacted]. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRETS) out = out.replace(re, "[redacted]");
  return out.replace(SECRET_ASSIGNMENT, (_m, key: string, sep: string) => `${key}${sep}[redacted]`);
}

// Fields whose whole value is secret, whatever it looks like.
const SECRET_FIELD = /pass(word|wd)?|secret|token$|api[_-]?key|access[_-]?key|private[_-]?key|authorization/i;

/** Redact every string in a record (field by field, so the JSON stays valid). */
export function redactFields(value: unknown, key = ""): unknown {
  if (typeof value === "string") return SECRET_FIELD.test(key) ? "[redacted]" : redact(value);
  if (Array.isArray(value)) return value.map((v) => redactFields(v, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactFields(v, k)]));
  return value;
}

export function containsSecret(text: string): boolean {
  return redact(text) !== text;
}

/**
 * Append-only JSONL audit log (one file per day under <stateDir>/logs), with secrets
 * redacted. Records what ran and how it went, never prompts or full tool output.
 */
export class AuditLog {
  private file: string | null;

  constructor(
    stateDir: string | null,
    readonly traceId: string,
    private debug: ((line: string) => void) | null = null,
  ) {
    this.file = null;
    if (!stateDir) return;
    try {
      const dir = path.join(stateDir, "logs");
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
      pruneOldLogs(dir, 14);
    } catch {
      this.file = null; // logging must never break the agent
    }
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    const safe = redactFields(data) as Record<string, unknown>;
    const line = JSON.stringify({ ts: new Date().toISOString(), trace: this.traceId, type, ...safe });
    if (this.debug) this.debug(`[debug] ${type} ${JSON.stringify(safe)}`);
    if (!this.file) return;
    try {
      fs.appendFileSync(this.file, line + "\n");
    } catch {
      this.file = null;
    }
  }
}

function pruneOldLogs(dir: string, days: number): void {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  for (const name of fs.readdirSync(dir)) {
    if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < cutoff) fs.rmSync(path.join(dir, name), { force: true });
  }
}
