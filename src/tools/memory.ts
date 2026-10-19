import type { FactKind } from "../memory/store.js";
import type { Tool } from "../types.js";
import { reqStr } from "./util.js";

const TTL_DAYS: Record<FactKind, number> = { command: 90, convention: 180, version: 7, source: 90, note: 30 };

export const remember: Tool = {
  name: "remember",
  description:
    "Save a durable fact about this project for future sessions: a build/test command that worked, a code convention, a framework version (expires after 7 days), or a short note. Never save secrets, file contents or temporary details.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["command", "convention", "version", "note"] },
      key: { type: "string", description: 'Short name, e.g. "test", "flutter", "state management"' },
      value: { type: "string", description: "The fact, under 300 characters" },
    },
    required: ["kind", "key", "value"],
  },
  // It changes what future sessions are told, so it is a write: not in ask/plan, approved in edit mode.
  risk: "write",
  describe: (a) => `remember ${a.kind} ${a.key}: ${a.value}`,
  async run(args, ctx) {
    if (!ctx.memory?.enabled) return "Memory is disabled; nothing was saved.";
    const kind = reqStr(args, "kind") as FactKind;
    const fact = ctx.memory.remember({
      project: ctx.cwd,
      kind,
      key: reqStr(args, "key").slice(0, 80),
      value: reqStr(args, "value"),
      source: "agent",
      confidence: 0.5,
      ttlDays: TTL_DAYS[kind] ?? 30,
    });
    return `Saved (#${fact.id}, ${kind} "${fact.key}", expires ${fact.expires_at?.slice(0, 10) ?? "never"}).`;
  },
};
