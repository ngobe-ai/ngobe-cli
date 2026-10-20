import crypto from "node:crypto";
import { Agent } from "./agent.js";
import path from "node:path";
import { loadAgents, type AgentDef } from "./agents.js";
import { configFilePath, type Config, type Mode } from "./config.js";
import { buildSessionContext, buildSystemPrompt, loadProjectInstructions } from "./context.js";
import { LLM } from "./llm.js";
import { AuditLog } from "./log.js";
import { Memory } from "./memory/store.js";
import { Permissions } from "./permissions.js";
import { detectProject, type ProjectInfo } from "./project.js";
import { buildTools } from "./tools/index.js";
import type { Tool } from "./types.js";
import type { Ui } from "./ui.js";

export interface Session {
  agent: Agent;
  llm: LLM;
  memory: Memory | null;
  tools: Tool[];
  project: ProjectInfo;
  log: AuditLog;
  /** Name of the prompt variant in use ("default" when none is promoted). */
  variant: string;
  agents: AgentDef[];
  perms: Permissions;
}

export interface SessionOptions {
  command?: string;
  /** Use this memory instead of opening the configured one (null = none). */
  memory?: Memory | null;
  /** Use these working instructions instead of the promoted variant (benchmarks). */
  variant?: { name: string; prompt: string };
}

/** Wire up everything one agent session needs. */
export async function createSession(config: Config, ui: Ui, opts: SessionOptions = {}): Promise<Session> {
  const memory = opts.memory !== undefined ? opts.memory : Memory.open(config, (m) => ui.warn(m));
  const active = memory?.enabled ? memory.meta("active_variant") : undefined;
  const variant = opts.variant ?? (active ? { name: active, prompt: memory?.variant(active)?.prompt ?? "" } : { name: "default", prompt: "" });

  const agents = loadAgents(config.cwd, path.dirname(configFilePath()));
  const tools = buildTools(config, { memory: !!memory?.enabled, agents });
  const [project, instructions] = await Promise.all([detectProject(config.cwd), loadProjectInstructions(config.cwd)]);

  let notes: string[] = [];
  let failures: string[] = [];
  if (memory?.enabled) {
    const facts = memory.recall(config.cwd, 12, ["command", "convention", "version", "note"]);
    memory.markUsed(facts.map((f) => f.id));
    notes = facts.map((f) => `${f.kind} ${f.key}: ${f.value} (${f.source}, confidence ${f.confidence.toFixed(1)}, ${f.updated_at.slice(0, 10)})`);
    failures = memory
      .failureClusters(14, config.cwd)
      .filter((c) => c.count >= 3)
      .slice(0, 3)
      .map((c) => `${c.count}× in ${c.tools.join("/")}: ${c.sample}`);
  }

  const llm = new LLM(config);
  llm.onNotice = (t) => ui.info(t);
  const log = new AuditLog(config.stateDir, crypto.randomUUID().slice(0, 8), config.debug ? (l) => ui.info(l) : null);
  // The system prompt is the same in every folder and mode, so the server keeps it (and the tools)
  // cached across sessions; what is particular to this one goes in the session context after them.
  const systemPrompt = buildSystemPrompt({ tools, workingInstructions: variant.prompt || undefined });
  const sessionContext = (mode: Mode) => buildSessionContext({ cwd: config.cwd, mode, instructions, project, notes, failures });
  log.event("session", { mode: config.mode, model: config.model, tools: tools.length, prompt_chars: systemPrompt.length, context_chars: sessionContext(config.mode).length, variant: variant.name });

  const perms = new Permissions(ui, config.mode);
  const agent = new Agent({
    config,
    llm,
    tools,
    ui,
    perms,
    systemPrompt,
    sessionContext,
    memory,
    log,
    command: opts.command,
    testCommand: project.commands.test,
    variant: variant.name,
  });
  return { agent, llm, memory, tools, project, log, variant: variant.name, agents, perms };
}
