import crypto from "node:crypto";
import type { Config, Mode } from "./config.js";
import { FRESHNESS_HINT, historySize, needsFreshInfo, transcript, trimHistory, truncate } from "./context.js";
import type { LLM, ToolCall } from "./llm.js";
import type { AuditLog } from "./log.js";
import type { Memory } from "./memory/store.js";
import { needOf, toolsForMode, type Permissions } from "./permissions.js";
import { validateArgs } from "./tools/schema.js";
import type { Args, FileTracker, Message, PreviewLine, Todo, Tool, ToolContext, ToolView } from "./types.js";
import type { AgentDef } from "./agents.js";
import { printable, type Activity, type Ui } from "./ui.js";

interface AgentDeps {
  config: Config;
  llm: LLM;
  tools: Tool[];
  ui: Ui;
  perms: Permissions;
  /** A function of the mode, so an approved plan (exit_plan_mode) gets a matching prompt. */
  systemPrompt: string | ((mode: Mode) => string);
  memory?: Memory | null;
  log?: AuditLog;
  /** Recorded with each run: the CLI command and the active prompt variant. */
  command?: string;
  variant?: string;
}

export type Outcome = "completed" | "declined" | "limit" | "cancelled" | "error";

/** Totals for the whole session (/cost). */
export interface SessionUsage {
  runs: number;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  ms: number;
}

/** Where the context budget goes (/context), in characters. */
export interface ContextUsage {
  system: number;
  tools: number;
  history: number;
  summary: number;
  budget: number;
}

export interface RunStats {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  tokensIn: number;
  tokensOut: number;
  tokensEstimated: boolean;
  modelMs: number;
  toolMs: number;
  durationMs: number;
  /** Whether tests the run executed passed, if it ran any. */
  tests: "passed" | "failed" | null;
}

export interface RunResult {
  outcome: Outcome;
  /** The model's final answer. */
  text: string;
  stats: RunStats;
  /** Tool calls in order, with their arguments (for evaluation). */
  calls: { name: string; args: Args; ok: boolean }[];
}

type ErrorClass = "unknown_tool" | "invalid_args" | "repeated" | "denied" | "timeout" | "cancelled" | "failed";

class ToolFailure extends Error {
  constructor(
    readonly kind: ErrorClass,
    message: string,
  ) {
    super(message);
  }
}

interface Prepared {
  call: ToolCall;
  tool?: Tool;
  args?: Args;
  /** Identity for repeat detection: name + arguments. */
  key?: string;
  /** Set when the call can't run (unknown tool, bad arguments, repeated). */
  failure?: ToolFailure;
}

/** How a tool call is labelled in the transcript: Read(src/a.ts). */
function viewOf(p: Prepared): Pick<ToolView, "id" | "label" | "target"> {
  const args = p.args ?? {};
  const first = Object.values(args).find((v) => typeof v === "string") as string | undefined;
  const target = p.tool?.target ? p.tool.target(args) : (first ?? "");
  return { id: p.call.id, label: p.tool?.label ?? p.call.name, target: printable(target.split("\n")[0].slice(0, 120)) };
}

function defaultSummary(output: string): { summary: string; preview?: PreviewLine[] } {
  return { summary: output.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "Done" };
}

const PARALLEL = 4; // concurrent read-only tool calls
const MAX_NUDGES = 2;
const NUDGE = "Continue: make the tool call now, in this reply. A reply without a tool call ends your turn.";
const FILLER = String.raw`^(?:(?:ok(?:ay)?|sure|great|alright|first|now|next|then)[,.!]?\s+)?`;
const INTENT = new RegExp(String.raw`${FILLER}(?:i(?:'ll| will|'m going to| am going to| need to| should)\b|let(?:'s| me| us)\b)`, "i");
const ACTIVITY = new RegExp(String.raw`${FILLER}(?:checking|looking|reading|running|searching|inspecting|exploring|examining|opening|listing|finding|investigating|analy[sz]ing|fixing|starting)\b`, "i");

/**
 * Small models often announce an action ("Checking for failing unit tests.") and end the reply
 * without calling a tool, which would end the run. Short announcements with no question for the
 * user are treated as "go on". Activity words only count before any tool has run: after that,
 * "Running the tests shows …" is more likely an answer.
 */
export function announcesAction(text: string, toolsUsed: boolean): boolean {
  const t = text.trim();
  if (!t || t.length > 300 || t.includes("?") || t.includes("```")) return false;
  return INTENT.test(t) || (!toolsUsed && ACTIVITY.test(t)) || /(:|\.\.\.|…)$/.test(t);
}
const TEST_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bbun test\b|\bpytest\b|\bphpunit\b|\bartisan test\b|\b(flutter|dart|go|cargo)\s+test\b|\bjest\b|\bvitest\b|\bmake test\b/;
const BUILD_COMMAND = /\b(npm|pnpm|yarn|bun)\s+run\s+build\b|\btsc\b|\b(cargo|go|flutter)\s+build\b|\bmake build\b/;

export class Agent {
  private messages: Message[] = [];
  /** Model-written summary of turns dropped from the history. */
  private summary = "";
  private files: FileTracker = new Map();
  private searchResults = new Set<string>();
  private todoList: Todo[] = [];
  /** Starts as configured; an approved plan (exit_plan_mode) switches it. */
  private mode: Mode;
  /** Status line state for the current run. */
  private status = { label: "", since: 0, tokens: 0 };
  readonly usage: SessionUsage = { runs: 0, tokensIn: 0, tokensOut: 0, toolCalls: 0, ms: 0 };

  constructor(private d: AgentDeps) {
    this.mode = d.config.mode;
  }

  reset() {
    this.messages = [];
    this.summary = "";
    this.files.clear();
    this.todoList = [];
    this.d.ui.todos([]);
  }

  get currentMode(): Mode {
    return this.mode;
  }

  get todos(): readonly Todo[] {
    return this.todoList;
  }

  /** Switch the permission mode (Shift+Tab, /mode, an approved plan). */
  setMode(mode: Mode): void {
    this.mode = mode;
    this.d.perms.setMode(mode);
    this.d.ui.modeChanged?.(mode);
  }

  private systemFor(mode: Mode): string {
    return typeof this.d.systemPrompt === "function" ? this.d.systemPrompt(mode) : this.d.systemPrompt;
  }

  contextUsage(): ContextUsage {
    const offered = toolsForMode(this.d.tools, this.mode);
    return {
      system: this.systemFor(this.mode).length,
      tools: JSON.stringify(offered.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))).length,
      history: historySize(this.messages),
      summary: this.summary.length,
      budget: this.d.config.maxContextChars,
    };
  }

  /** /compact: summarize the conversation so far and continue from the summary. */
  async compactNow(signal: AbortSignal, focus = ""): Promise<boolean> {
    if (!this.messages.length) return false;
    await this.compact(signal, { force: true, focus });
    return true;
  }

  private show(label: string, tokens?: number): void {
    if (label) this.status.label = label;
    if (tokens !== undefined) this.status.tokens = tokens;
    this.d.ui.activity({ ...this.status });
  }

  /** One user request: loop model -> tools -> model until the model answers without tool calls. */
  async run(userInput: string, signal: AbortSignal): Promise<RunResult> {
    const { config, llm, ui } = this.d;
    const runId = crypto.randomUUID().slice(0, 8);
    const started = Date.now();
    const stats: RunStats = { turns: 0, toolCalls: 0, toolErrors: 0, tokensIn: 0, tokensOut: 0, tokensEstimated: false, modelMs: 0, toolMs: 0, durationMs: 0, tests: null };
    const result: RunResult = { outcome: "completed", text: "", stats, calls: [] };
    const repeats = new Map<string, number>();
    let nudges = 0;
    const fresh = needsFreshInfo(userInput);
    this.d.log?.event("run_start", { run: runId, mode: this.mode, model: config.model, chars: userInput.length, fresh });
    // The hint rides on the user message, not the system prompt: the system prompt and tool list stay
    // byte-identical between requests, so llama.cpp reuses its cache of them instead of re-reading.
    this.messages.push({ role: "user", content: fresh ? `${userInput}\n\n(${FRESHNESS_HINT})` : userInput });
    this.status = { label: "Thinking", since: started, tokens: 0 };

    try {
      for (;;) {
        if (stats.turns >= config.maxTurns) {
          result.outcome = "limit";
          ui.warn(`Stopped after ${config.maxTurns} turns (NGOBE_MAX_TURNS).`);
          break;
        }
        if (Date.now() - started > config.maxRunSeconds * 1000) {
          result.outcome = "limit";
          ui.warn(`Stopped: the run took longer than ${config.maxRunSeconds}s (NGOBE_MAX_RUN_SECONDS).`);
          break;
        }
        trimHistory(this.messages, config.maxContextChars);
        this.show("Thinking");
        await this.compact(signal);
        const offered = toolsForMode(this.d.tools, this.mode);
        const byName = new Map(offered.map((t) => [t.name, t]));

        const system = this.systemFor(this.mode);
        // The summary was written from tool output, so it goes in the conversation, not the system prompt.
        const earlier: Message[] = this.summary
          ? [
              { role: "user", content: `[Summary of the earlier conversation, for context only]\n${this.summary}` },
              { role: "assistant", content: "Understood." },
            ]
          : [];
        let streamed = 0;
        const turn = await llm.chat(
          [{ role: "system", content: system }, ...earlier, ...this.messages],
          offered,
          (chunk) => {
            if (streamed === 0) this.show("Responding");
            streamed += chunk.length;
            this.show("", stats.tokensIn + stats.tokensOut + Math.ceil(streamed / 4));
            ui.write(chunk);
          },
          signal,
        );
        ui.endTurn();
        stats.turns++;
        stats.modelMs += turn.totalMs;
        stats.tokensIn += turn.usage.input;
        stats.tokensOut += turn.usage.output;
        stats.tokensEstimated ||= turn.usage.estimated;
        this.show("", stats.tokensIn + stats.tokensOut);
        this.d.log?.event("model", {
          run: runId,
          model: turn.model,
          ms: turn.totalMs,
          first_token_ms: turn.firstTokenMs,
          tokens_in: turn.usage.input,
          tokens_out: turn.usage.output,
          estimated: turn.usage.estimated,
          tool_calls: turn.toolCalls.map((c) => c.name),
        });

        this.messages.push({
          role: "assistant",
          content: turn.content || null,
          tool_calls: turn.toolCalls.length
            ? turn.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } }))
            : undefined,
        });
        if (turn.toolCalls.length === 0) {
          if (nudges < MAX_NUDGES && offered.length && announcesAction(turn.content, stats.toolCalls > 0)) {
            nudges++;
            this.messages.push({ role: "user", content: NUDGE });
            this.d.log?.event("nudge", { run: runId, reply: turn.content.slice(0, 120) });
            continue;
          }
          result.text = turn.content;
          break;
        }

        if (stats.toolCalls + turn.toolCalls.length > config.maxToolCalls) {
          for (const c of turn.toolCalls) this.messages.push({ role: "tool", tool_call_id: c.id, content: "Not run: the tool-call limit for this request was reached." });
          result.outcome = "limit";
          ui.warn(`Stopped: more than ${config.maxToolCalls} tool calls (NGOBE_MAX_TOOL_CALLS).`);
          break;
        }
        let outputs: string[] = [];
        let declined = false;
        try {
          ({ outputs, declined } = await this.runCalls(turn.toolCalls, byName, repeats, signal, runId, result));
        } finally {
          // Every tool_call needs a matching tool message, even when cancelled or on an internal error.
          turn.toolCalls.forEach((c, i) => this.messages.push({ role: "tool", tool_call_id: c.id, content: outputs[i] ?? "Error: the tool did not run." }));
        }
        if (signal.aborted) break;
        if (declined) {
          // Like Claude Code: a declined action hands the turn back to the user.
          result.outcome = "declined";
          ui.info("Declined. Tell ngobe what to do instead.");
          break;
        }
      }
      if (signal.aborted) result.outcome = "cancelled";
      return result;
    } catch (err) {
      result.outcome = signal.aborted ? "cancelled" : "error";
      this.d.log?.event("run_error", { run: runId, error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      stats.durationMs = Date.now() - started;
      this.usage.runs++;
      this.usage.tokensIn += stats.tokensIn;
      this.usage.tokensOut += stats.tokensOut;
      this.usage.toolCalls += stats.toolCalls;
      this.usage.ms += stats.durationMs;
      ui.activity(null);
      ui.runDone({ outcome: result.outcome, ms: stats.durationMs, tokens: stats.tokensIn + stats.tokensOut, toolCalls: stats.toolCalls });
      this.record(runId, started, result);
    }
  }

  /** Validate every call, then run them: read-only batches in parallel, anything needing approval in order. */
  private async runCalls(
    calls: ToolCall[],
    byName: Map<string, Tool>,
    repeats: Map<string, number>,
    signal: AbortSignal,
    runId: string,
    result: RunResult,
  ): Promise<{ outputs: string[]; declined: boolean }> {
    const prepared = calls.map((c) => this.prepare(c, byName, repeats));
    const quiet = (p: Prepared) => !p.failure && p.tool && (p.tool.risk === "safe" || p.tool.risk === "network") && needOf(p.tool, p.args!) === "none";
    const outputs: string[] = new Array(calls.length);
    let declined = false;

    if (prepared.length > 1 && prepared.every(quiet)) {
      for (const p of prepared) this.d.ui.toolUpdate({ ...viewOf(p), state: "running" });
      this.show(prepared.every((p) => p.tool?.name === "read_file") ? `Reading ${prepared.length} files` : `Running ${prepared.length} tools`);
      let next = 0;
      const worker = async () => {
        while (next < prepared.length) {
          const i = next++;
          outputs[i] = (await this.execute(prepared[i], signal, runId, result, false, repeats)).output;
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, prepared.length) }, worker));
    } else {
      for (let i = 0; i < prepared.length; i++) {
        if (signal.aborted || declined) {
          outputs[i] = signal.aborted ? "Cancelled by user." : "Not run: the user declined an earlier action.";
          continue;
        }
        const r = await this.execute(prepared[i], signal, runId, result, true, repeats);
        outputs[i] = r.output;
        declined ||= r.declined;
      }
    }
    return { outputs, declined };
  }

  private prepare(call: ToolCall, byName: Map<string, Tool>, repeats: Map<string, number>): Prepared {
    const tool = byName.get(call.name);
    if (!tool) {
      return { call, failure: new ToolFailure("unknown_tool", `unknown tool "${call.name}". Available: ${[...byName.keys()].join(", ")}`) };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments || "{}");
    } catch {
      return { call, tool, failure: new ToolFailure("invalid_args", `arguments for ${call.name} were not valid JSON. Retry with a JSON object.`) };
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { call, tool, failure: new ToolFailure("invalid_args", `arguments for ${call.name} must be a JSON object.`) };
    }
    for (const [from, to] of Object.entries(tool.aliases ?? {})) {
      const r = raw as Args;
      if (r[from] !== undefined && r[to] === undefined) {
        r[to] = r[from];
        delete r[from];
      }
    }
    const { args, errors } = validateArgs(tool.parameters, raw as Args);
    if (errors.length) return { call, tool, failure: new ToolFailure("invalid_args", `invalid arguments for ${call.name}: ${errors.join("; ")}.`) };

    const key = `${call.name} ${JSON.stringify(args, Object.keys(args).sort())}`;
    const seen = (repeats.get(key) ?? 0) + 1;
    repeats.set(key, seen);
    if (seen > 2) {
      return { call, tool, args, key, failure: new ToolFailure("repeated", `you already made this exact ${call.name} call ${seen - 1} times since anything changed. Use the earlier result or try a different approach.`) };
    }
    return { call, tool, args, key };
  }

  /** Memory bookkeeping must never break a run (e.g. SQLITE_BUSY from another ngobe process). */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.d.log?.event("memory_error", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async execute(
    p: Prepared,
    signal: AbortSignal,
    runId: string,
    result: RunResult,
    announce: boolean,
    repeats: Map<string, number>,
  ): Promise<{ output: string; declined: boolean }> {
    const { ui, perms, config, memory, log } = this.d;
    const started = Date.now();
    const name = p.tool?.name ?? p.call.name;
    const view = viewOf(p);
    let output: string;
    let failure: ToolFailure | null = p.failure ?? null;

    if (!failure) {
      const tool = p.tool!;
      const args = p.args!;
      if (announce) ui.toolUpdate({ ...view, state: "running" });
      if (!(await perms.check(tool, args))) failure = new ToolFailure("denied", "the user declined this action. Don't retry it; wait for their instructions.");
      else if (signal.aborted) failure = new ToolFailure("cancelled", "cancelled by user."); // Ctrl+C while the prompt was open
      if (!failure && announce) this.show(tool.activity?.(args) ?? `Running ${tool.label ?? tool.name}`);
    }
    if (failure) {
      output = `Error: ${failure.message}`;
    } else {
      try {
        // Tool results are re-read on every later turn: keep them within a share of the context budget.
        const limit = Math.min(20_000, Math.max(2_000, Math.floor(config.maxContextChars / 5)));
        output = truncate(await withTimeout(p.tool!, (s) => p.tool!.run(p.args!, this.context(s)), signal), limit);
      } catch (err) {
        failure = err instanceof ToolFailure ? err : new ToolFailure(signal.aborted ? "cancelled" : "failed", err instanceof Error ? err.message : String(err));
        // Error text goes back to the model so it can correct itself.
        output = `Error: ${failure.message}`;
      }
    }

    const ms = Date.now() - started;
    result.stats.toolCalls++;
    result.stats.toolMs += ms;
    result.calls.push({ name, args: p.args ?? {}, ok: !failure });
    if (failure) result.stats.toolErrors++;
    log?.event("tool", { run: runId, tool: name, ms, ok: !failure, error: failure?.kind, summary: p.tool && p.args ? (p.tool.describe?.(p.args) ?? name).slice(0, 200) : name });
    this.safely(() => {
      if (!memory?.enabled) return;
      memory.recordToolEvent(runId, name, !failure, failure?.kind ?? null, ms);
      if (failure && failure.kind !== "denied" && failure.kind !== "cancelled") memory.recordFailure(runId, config.cwd, name, failure.message);
    });
    if (!failure && name === "bash") this.safely(() => this.observeCommand(String(p.args?.command ?? ""), output, runId, result));
    // Something changed (a file write, a command): other calls may now give different results.
    if (!failure && p.key && (p.tool?.risk === "write" || p.tool?.risk === "exec")) {
      for (const k of [...repeats.keys()]) if (k !== p.key) repeats.delete(k);
    }

    let shown: { summary: string; preview?: PreviewLine[] };
    try {
      shown = failure
        ? { summary: failure.kind === "denied" ? "Declined" : failure.message.split("\n")[0].slice(0, 160) }
        : (p.tool?.summarize?.(p.args ?? {}, output, ms) ?? defaultSummary(output));
    } catch {
      shown = defaultSummary(output);
    }
    ui.toolUpdate({ ...view, state: !failure ? "ok" : failure.kind === "denied" ? "declined" : "error", ...shown });
    return { output, declined: failure?.kind === "denied" };
  }

  /** Learn from shell results: whether tests passed, and which test/build commands work here. */
  private observeCommand(command: string, output: string, runId: string, result: RunResult): void {
    const code = Number(/^exit code (\d+)/.exec(output)?.[1] ?? NaN);
    if (!Number.isFinite(code)) return;
    const { memory, config } = this.d;
    const isTest = TEST_COMMAND.test(command);
    if (isTest) result.stats.tests = code === 0 ? "passed" : "failed";
    if (!memory?.enabled) return;
    if (code !== 0) {
      const errorLine = output.split("\n").reverse().find((l) => /error|failed|exception|not found|cannot|denied|undefined/i.test(l)) ?? output.split("\n")[1] ?? "";
      memory.recordFailure(runId, config.cwd, "bash", `${command.slice(0, 80)}: ${errorLine.slice(0, 200)}`);
      if (code === 127) memory.weaken(config.cwd, "command", isTest ? "test" : "build");
      return;
    }
    const kind = isTest ? "test" : BUILD_COMMAND.test(command) ? "build" : null;
    if (kind && command.length < 200 && !command.includes("\n")) {
      try {
        memory.remember({ project: config.cwd, kind: "command", key: kind, value: command, source: "observed", confidence: 0.6, ttlDays: 90 });
      } catch {
        // commands containing credentials are not remembered
      }
    }
  }

  private context(signal: AbortSignal): ToolContext {
    const { config, memory, ui, perms } = this.d;
    return {
      cwd: config.cwd,
      signal,
      config,
      files: this.files,
      memory,
      searchResults: this.searchResults,
      todos: {
        list: this.todoList,
        set: (list) => {
          this.todoList = list;
          ui.todos(list);
        },
      },
      confirm: (prompt) => ui.confirm(prompt),
      setMode: (mode) => {
        this.setMode(mode);
        ui.info(`Plan approved: now in ${mode} mode.`);
      },
      spawn: (agent, prompt) => this.spawn(agent, prompt, signal),
    };
  }

  /**
   * A sub-agent: same model, permissions and project, a fresh conversation and its own tool set.
   * Its tool calls show in the transcript under its name; its reply text comes back as the
   * task's result instead of streaming to the user.
   */
  private async spawn(def: AgentDef, prompt: string, signal: AbortSignal): Promise<string> {
    const parent = this.d.ui;
    const tag = (s: string) => `${def.name} › ${s}`;
    const ui: Ui = {
      ask: () => Promise.reject(new Error("sub-agents cannot ask the user for input")),
      confirm: (p) => parent.confirm(`[${def.name}] ${p}`),
      write: () => {},
      endTurn: () => {},
      info: (t) => parent.info(tag(t)),
      warn: (t) => parent.warn(tag(t)),
      error: (t) => parent.error(tag(t)),
      toolUpdate: (v) => parent.toolUpdate({ ...v, id: `${def.name}:${v.id}`, label: tag(v.label) }),
      activity: (a: Activity | null) => a && parent.activity({ ...a, label: tag(a.label) }),
      todos: () => {},
      runDone: () => {},
      onInterrupt: () => {},
      close: () => {},
    };
    const tools = this.d.tools.filter((t) => t.name !== "task" && (!def.tools || def.tools.includes(t.name)));
    const sub = new Agent({
      ...this.d,
      tools,
      ui,
      command: `agent:${def.name}`,
      systemPrompt: (mode) =>
        `${this.systemFor(mode)}\n\nYou are the "${def.name}" sub-agent, working on one task for the main agent. ${def.prompt}\nYour final reply is all the main agent sees: make it a complete, concise report (with file:line references where useful).`,
    });
    sub.mode = this.mode;
    const result = await sub.run(prompt, signal);
    this.usage.tokensIn += result.stats.tokensIn;
    this.usage.tokensOut += result.stats.tokensOut;
    if (result.outcome === "cancelled") throw new Error("cancelled by user");
    const report = result.text.trim();
    return report || `The ${def.name} agent finished (${result.outcome}) without a report.`;
  }

  /** When trimming wasn't enough, have the model summarize earlier requests and drop them. */
  private async compact(signal: AbortSignal, opts: { force?: boolean; focus?: string } = {}): Promise<void> {
    const { config, llm, log } = this.d;
    if (!opts.force && historySize(this.messages) <= config.maxContextChars) return;
    // Cut at the latest user request: everything before it is summarized, the current task stays whole.
    // /compact runs between requests, so it summarizes everything.
    let cut = opts.force ? this.messages.length : -1;
    for (let i = this.messages.length - 1; i > 0 && cut < 0; i--) {
      if (this.messages[i].role === "user") cut = i;
    }
    if (cut <= 0) return;
    const res = await llm.chat(
      [
        {
          role: "system",
          content:
            `Summarize this coding session so it can be continued: the user's goals, decisions made, files changed, commands run and their results, and open problems. Be specific and under 300 words.${opts.focus ? ` Focus on: ${opts.focus}` : ""}`,
        },
        { role: "user", content: transcript(this.messages.slice(0, cut), Math.floor(config.maxContextChars / 2)) },
      ],
      [],
      () => {},
      signal,
    );
    this.summary = [this.summary, res.content.trim()].filter(Boolean).join("\n");
    this.messages = this.messages.slice(cut);
    log?.event("compact", { dropped: cut, summary_chars: res.content.length });
  }

  private record(runId: string, started: number, result: RunResult): void {
    const { config, memory, log, command, variant } = this.d;
    const s = result.stats;
    log?.event("run_end", { run: runId, outcome: result.outcome, ms: s.durationMs, model_ms: s.modelMs, tool_ms: s.toolMs, turns: s.turns, tool_calls: s.toolCalls, tool_errors: s.toolErrors, tests: s.tests });
    if (!memory?.enabled) return;
    try {
      memory.recordRun({
        id: runId,
        project: config.cwd,
        command: command ?? "",
        mode: this.mode,
        model: config.model,
        variant: variant ?? "",
        started_at: new Date(started).toISOString(),
        duration_ms: s.durationMs,
        model_ms: s.modelMs,
        tool_ms: s.toolMs,
        turns: s.turns,
        tool_calls: s.toolCalls,
        tool_errors: s.toolErrors,
        tokens_in: s.tokensIn,
        tokens_out: s.tokensOut,
        tokens_estimated: s.tokensEstimated ? 1 : 0,
        outcome: result.outcome,
        tests: s.tests,
      });
    } catch {
      // recording outcomes must never fail a run
    }
  }
}

/** Run a tool under its time limit; the signal it gets is aborted on timeout or Ctrl+C. */
async function withTimeout(tool: Tool, fn: (signal: AbortSignal) => Promise<string>, signal: AbortSignal): Promise<string> {
  const ms = tool.timeoutMs ?? 120_000;
  if (ms === 0) return fn(signal);
  const timeout = AbortSignal.timeout(ms);
  const combined = AbortSignal.any([signal, timeout]);
  return Promise.race([
    fn(combined),
    new Promise<never>((_, reject) =>
      timeout.addEventListener("abort", () => reject(new ToolFailure("timeout", `${tool.name} timed out after ${ms / 1000}s`)), { once: true }),
    ),
  ]);
}
