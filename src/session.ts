import crypto from "node:crypto";
import { Agent } from "./agent.js";
import path from "node:path";
import { loadAgents, type AgentDef } from "./agents.js";
import { configFilePath, type Config, type Mode } from "./config.js";
import { buildSessionContext, buildSystemPrompt, loadProjectInstructions, topLevelEntries } from "./context.js";
import { LLM } from "./llm.js";
import { AuditLog } from "./log.js";
import { Memory } from "./memory/store.js";
import { Permissions } from "./permissions.js";
import { detectProject, type ProjectInfo } from "./project.js";
import { buildTools } from "./tools/index.js";
import type { Tool } from "./types.js";
import type { Ui } from "./ui.js";
import { ProjectMemory } from "./projectMemory.js";
import type { McpManager } from "./mcp/index.js";
import { isTrusted } from "./trust.js";

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
  /** NGOBE.md and the record of the latest work per project (null when memory is off). */
  projectMemory: ProjectMemory | null;
  /** The MCP servers and their tools (null when MCP is off); close() stops them. */
  mcp: McpManager | null;
}

export interface SessionOptions {
  command?: string;
  /** Use this memory instead of opening the configured one (null = none). */
  memory?: Memory | null;
  /** Use these working instructions instead of the promoted variant (benchmarks). */
  variant?: { name: string; prompt: string };
  /** false: no MCP servers (benchmarks compare prompts, not the user's servers). */
  mcp?: boolean;
}

/** Wire up everything one agent session needs. */
export async function createSession(config: Config, ui: Ui, opts: SessionOptions = {}): Promise<Session> {
  const memory = opts.memory !== undefined ? opts.memory : Memory.open(config, (m) => ui.warn(m));
  const active = memory?.enabled ? memory.meta("active_variant") : undefined;
  const variant = opts.variant ?? (active ? { name: active, prompt: memory?.variant(active)?.prompt ?? "" } : { name: "default", prompt: "" });

  const agents = loadAgents(config.cwd, path.dirname(configFilePath()));
  const log = new AuditLog(config.stateDir, crypto.randomUUID().slice(0, 8), config.debug ? (l) => ui.info(l) : null);
  // MCP servers start alongside the project scan; their tools go last, in a fixed order, so the
  // tool list (part of the prompt prefix the model server caches) stays the same between sessions.
  const startMcp = async () => {
    if (opts.mcp === false || !config.mcp) return null;
    const { McpManager } = await import("./mcp/index.js");
    return McpManager.start(config, { trusted: isTrusted(config.cwd, config.stateDir), log: (e, d) => log.event(e, d), warn: (t) => ui.warn(t) });
  };
  const [project, instructions, topLevel, mcp] = await Promise.all([detectProject(config.cwd), loadProjectInstructions(config.cwd), topLevelEntries(config.cwd), startMcp()]);
  const tools = [...buildTools(config, { memory: !!memory?.enabled, agents }), ...(mcp?.tools ?? [])];

  let notes: string[] = [];
  let failures: string[] = [];
  if (memory?.enabled) {
    const facts = memory.recall(config.cwd, 12, ["command", "convention", "version", "note"]); // lessons are in NGOBE.md
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
  // The system prompt is the same in every folder and mode, so the server keeps it (and the tools)
  // cached across sessions; what is particular to this one goes in the session context after them.
  const systemPrompt = buildSystemPrompt({ tools, workingInstructions: variant.prompt || undefined });
  // Benchmarks and tests pass memory: null, and must not write to the user's NGOBE.md either.
  const projectMemory = config.memory && opts.memory !== null ? new ProjectMemory(config.memoryFile, config.stateDir) : null;
  let remembered = "";
  try {
    remembered = projectMemory?.contextFor(config.cwd) ?? "";
  } catch (err) {
    ui.warn(`Could not read ${config.memoryFile}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const sessionContext = (mode: Mode) => buildSessionContext({ cwd: config.cwd, mode, instructions, project, notes, failures, topLevel, memory: remembered });
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
    projectMemory,
    memory,
    log,
    command: opts.command,
    testCommand: project.commands.test,
    stack: project.stack,
    variant: variant.name,
  });
  return { agent, llm, memory, tools, project, log, variant: variant.name, agents, perms, projectMemory, mcp };
}
