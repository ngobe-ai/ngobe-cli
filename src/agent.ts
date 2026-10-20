import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config, Mode } from "./config.js";
import { FRESHNESS_HINT, historySize, modeNote, needsFreshInfo, transcript, trimHistory, truncate } from "./context.js";
import type { LLM, ToolCall } from "./llm.js";
import type { AuditLog } from "./log.js";
import type { Memory } from "./memory/store.js";
import { isCorrection, isResumeRequest, projectRootOf, resumeNote, userNote, type ProjectMemory, type WorkRecord } from "./projectMemory.js";
import { briefDescription } from "./tools/overview.js";
import { KNOWN_NAMES } from "./releases/versions.js";
import { fromImage, uiHint, wantsUi } from "./design.js";
import { fileHandoff } from "./toolProtocol.js";
import { redact } from "./log.js";
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
  /**
   * Best the same for every request: llama.cpp re-reads everything after the first difference.
   * (A function of the mode is accepted; sub-agents extend the prompt this way.)
   */
  systemPrompt: string | ((mode: Mode) => string);
  /**
   * The folder, project and starting mode, sent once after the system prompt and tools. It is fixed
   * when first used; a later mode change is told in the next message instead.
   */
  sessionContext?: string | ((mode: Mode) => string);
  memory?: Memory | null;
  log?: AuditLog;
  /** Recorded with each run: the CLI command and the active prompt variant. */
  command?: string;
  variant?: string;
  /** The project's test command (from its manifests), for "let's run the tests" without a call. */
  testCommand?: string;
  /** NGOBE.md and the record of the latest work per project (null: memory is off). */
  projectMemory?: ProjectMemory | null;
  /** The project's stack ("Flutter", "React", "Tailwind" …): how a UI request should be built. */
  stack?: string[];
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
const LOADING = "Loading the model on the server";
const MAX_NUDGES = 2;
const NUDGE = "Continue: make the tool call now, in this reply. A reply without a tool call ends your turn.";
// "Analyse / understand / explore … the project / app / codebase": a request to get to know it.
const EXPLORE = /\b(?:analy[sz]e|understand|explore|overview|walk (?:me )?through|familiari[sz]e|get to know|tour of|describe|summari[sz]e)\b/i;
const SUBJECT = /\b(?:project|repo(?:sitory)?|codebase|code base|app|application|folder|directory|monorepo|workspace|structure)\b/i;
/**
 * Files the request names that exist ("summarize ~/Downloads/report.pdf", "the bug in src/sum.js"),
 * at most three: read before the first turn, since a small model often answers "I don't have access
 * to the file" instead of reading it. Quoted names, absolute and ~ paths (drag-and-drop escapes
 * spaces with "\ "), and relative paths with an extension count; URLs don't.
 */
export function namedFiles(input: string, cwd: string): string[] {
  const candidates = [
    ...[...input.matchAll(/[`'"]([^`'"\n]{2,300})[`'"]/g)].map((m) => m[1]),
    ...[...input.matchAll(/(?:^|[\s(])((?:~|\.{1,2})?\/(?:\\ |[^\s'"`])+)/g)].map((m) => m[1].replace(/\\ /g, " ")),
    ...[...input.matchAll(/(?:^|[\s(])((?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,8})(?=$|[\s,;:!?)]|\.(?:\s|$))/g)].map((m) => m[1]),
  ].map((c) => c.replace(/[.,;:!?)]+$/, ""));
  const found: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (c.includes("://") || found.length >= 3) continue;
    const abs = path.resolve(cwd, c === "~" || c.startsWith("~/") ? path.join(os.homedir(), c.slice(1)) : c);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) found.push(c);
  }
  return found;
}

// "Add / build / integrate …" with a framework, library or service in it: worth checking current docs first.
const BUILD = /\b(?:build|create|implement|add|integrate|set ?up|scaffold|develop|migrate|upgrade|install|connect|configure|use)\b/i;
const SERVICE =
  /\b(?:api|sdk|oauth|webhooks?|payments?|stripe|paypal|firebase|supabase|aws|s3|openai|graphql|websockets?|redis|mongodb|mysql|auth0|clerk|twilio|sendgrid|mapbox|google (?:sign[- ]?in|maps|login))\b/i;
// Known names that are also everyday words ("add a next button", "go ahead").
const AMBIGUOUS = new Set(["next", "go", "express", "node", "npm", "pnpm"]);

/** For a build request naming a technology: its latest version (at most two) and a docs search, if offered. */
export function researchCalls(input: string, offered: Map<string, Tool>): [string, Args][] {
  if (!BUILD.test(input)) return [];
  const named = KNOWN_NAMES.filter((n) => !AMBIGUOUS.has(n) && new RegExp(String.raw`(?<![\w.-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\w-])`, "i").test(input));
  if (!named.length && !SERVICE.test(input)) return [];
  const calls: [string, Args][] = [];
  if (offered.has("check_latest_version")) for (const name of named.slice(0, 2)) calls.push(["check_latest_version", { name }]);
  if (offered.has("web_search")) calls.push(["web_search", { query: `${redact(input.replace(/\s+/g, " ").trim()).slice(0, 150)} documentation` }]);
  return calls;
}

const LENGTH_NUDGE =
  "Your reply was cut off at the length limit (about 4,000 tokens), so nothing in it was saved. Write big files in parts: write_file with the first part (up to ~200 lines), then add the rest with edit_file, appending after the last lines. Or split the work into smaller files or components.";

function isJsonObject(s: string): boolean {
  try {
    const v = JSON.parse(s) as unknown;
    return !!v && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
}

const RUN_TESTS = /\b(?:re-?run|run|execute)\b[^.\n]{0,25}\btests?\b/i;
const CHANGE_NUDGE =
  "You haven't changed any file yet. Make the change yourself: read_file the file to change, then edit_file it (don't show the code to the user), then verify it.";
const CHANGE_REQUEST = /\b(?:fix|add|implement|change|update|refactor|create|remove|delete|rename|write|build|convert|migrate|upgrade|bump|replace|correct|resolve|repair|make)\b/i;
const QUESTION = /^\s*(?:why|what|where|how|when|which|who|explain|describe)\b/i;

/** The user asked for a change to the project (not an explanation of one). */
export function wantsChange(request: string): boolean {
  return CHANGE_REQUEST.test(request) && !QUESTION.test(request);
}
// Also a leading clause: "To confirm the installed version, I'll run …"
const FILLER = String.raw`^(?:(?:ok(?:ay)?|sure|great|alright|first|now|next|then|so)[,.!]?\s+)?(?:[^,.!?]{1,100},\s*)?`;
const VERBS =
  "run|re-?run|check|look|read|search|find|fix|update|edit|open|start|try|inspect|examine|investigate|create|write|add|implement|locate|use|call|install|verify|test|review|explore|list|modify|change|make|begin|identify|analy[sz]e|debug|see|get|take|navigate|correct|resolve|apply|execute|go ahead";
// "I'll run …", "Let's locate …" (an action verb, so "Let me know …" and "I will be here …" don't count)
const INTENT = new RegExp(String.raw`${FILLER}(?:i(?:'ll| will|'m going to| am going to| need to| should)|let(?:'s| me| us))\s+(?:now\s+|first\s+|then\s+|also\s+)?(?:${VERBS})\b`, "i");
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
  // The announcement opens the reply, or closes it ("The sum is off by one. Let's fix it.").
  const sentences = t.split(/(?<=[.!])\s+/);
  const ends = [sentences[0], sentences[sentences.length - 1]];
  return ends.some((x) => INTENT.test(x) || (!toolsUsed && ACTIVITY.test(x))) || /(:|\.\.\.|…)$/.test(t);
}
const TEST_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bbun test\b|\bpytest\b|\bphpunit\b|\bartisan test\b|\b(flutter|dart|go|cargo)\s+test\b|\bjest\b|\bvitest\b|\bmake test\b|\bnode --test\b|\bdeno test\b/;
const BUILD_COMMAND = /\b(npm|pnpm|yarn|bun)\s+run\s+build\b|\btsc\b|\b(cargo|go|flutter)\s+build\b|\bmake build\b/;

export class Agent {
  private messages: Message[] = [];
  /** Model-written summary of turns dropped from the history. */
  private summary = "";
  /** The session context, fixed when first sent (null until then), and the last mode the model was told. */
  private opening: string | null = null;
  private toldMode: Mode;
  /** What this run has done, for NGOBE.md and "where did we stop?" (saved once a tool has run). */
  private work: WorkRecord | null = null;
  private workTouched = false;
  /** The user's current request: files it names may be read even outside the project. */
  private request = "";
  /** The request before it in this session, for learning from a correction of its answer. */
  private lastRequest: string | null = null;
  /** The folder a project_overview looked at in this run: the project the work was about. */
  private lookedAt: string | null = null;
  /** This run's failed calls by tool: one that later works with other arguments becomes a lesson. */
  private failedCalls = new Map<string, { args: string; error: string }>();
  private files: FileTracker = new Map();
  private searchResults = new Set<string>();
  private todoList: Todo[] = [];
  /** Starts as configured; an approved plan (exit_plan_mode) switches it. */
  private mode: Mode;
  /** Status line state for the current run. */
  private status = { label: "", since: 0, tokens: 0 };
  readonly usage: SessionUsage = { runs: 0, tokensIn: 0, tokensOut: 0, toolCalls: 0, ms: 0 };
  /** When the model last worked for us (a run or a warm-up): the server unloads idle models. */
  private lastActive = 0;
  private warming: Promise<number | null> | null = null;
  /** A run is in progress (the status line belongs to it). */
  private running = false;
  /** The last test command run through bash this session. */
  private lastTest: string | undefined;

  constructor(private d: AgentDeps) {
    this.mode = d.config.mode;
    this.toldMode = this.mode;
  }

  reset() {
    this.messages = [];
    this.summary = "";
    this.files.clear();
    this.todoList = [];
    this.d.ui.todos([]);
  }

  /**
   * Send the fixed prompt prefix (system prompt + tools of the current mode) ahead of the first
   * request, so the server has it cached. Resolves with the time it took, or null on failure
   * (a warm-up never reports errors: the real request will).
   */
  warmup(signal?: AbortSignal): Promise<number | null> {
    // The conversation so far plus a throwaway message: the server caches everything before it,
    // which is exactly the start of the next real request.
    this.warming ??= this.d.llm
      .warm([...this.conversation(), { role: "user", content: "hi" }], toolsForMode(this.d.tools, this.mode), signal)
      .then(
        (ms) => {
          this.d.log?.event("warmup", { ms });
          return ms;
        },
        (err) => {
          this.d.log?.event("warmup_error", { error: err instanceof Error ? err.message : String(err) });
          return null;
        },
      )
      .finally(() => {
        this.warming = null;
        this.lastActive = Date.now();
        if (this.running && this.status.label === LOADING) this.show("Thinking");
      });
    return this.warming;
  }

  /** What every request starts with: the system prompt, the summary of older turns, the history. */
  private conversation(): Message[] {
    // The summary was written from tool output, so it goes in the conversation, not the system prompt.
    const earlier: Message[] = this.summary
      ? [
          { role: "user", content: `[Summary of the earlier conversation, for context only]\n${this.summary}` },
          { role: "assistant", content: "Understood." },
        ]
      : [];
    const context = this.sessionContext();
    const opening: Message[] = context ? [{ role: "user", content: context }, { role: "assistant", content: "Understood." }] : [];
    return [{ role: "system", content: this.systemFor(this.mode) }, ...opening, ...earlier, ...this.messages];
  }

  private sessionContext(): string {
    if (this.opening === null) {
      const c = this.d.sessionContext;
      this.opening = typeof c === "function" ? c(this.mode) : (c ?? "");
      this.toldMode = this.mode;
    }
    return this.opening;
  }

  /**
   * The folder to look over when the request is about getting to know a project ("analyse and
   * understand the hype project"): a folder of the project the request names, else the project.
   */
  private overviewTarget(input: string): string | null {
    if (!EXPLORE.test(input) || !SUBJECT.test(input) || !toolsForMode(this.d.tools, this.mode).some((t) => t.name === "project_overview")) return null;
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(this.d.config.cwd, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
    } catch {
      return ".";
    }
    const words = new Set(input.toLowerCase().split(/[^\w.-]+/));
    return dirs.filter((d) => words.has(d.toLowerCase())).sort((a, b) => b.length - a.length)[0] ?? ".";
  }

  /** Tell the model about a mode change in the newest message, which hasn't been sent yet. */
  private tellMode(): void {
    this.sessionContext(); // it states the mode the session started in
    const last = this.messages[this.messages.length - 1];
    if (this.mode === this.toldMode || !last || (last.role !== "user" && last.role !== "tool") || typeof last.content !== "string") return;
    last.content = `${last.content}\n\n${modeNote(this.mode)}`;
    this.toldMode = this.mode;
  }

  /** Milliseconds since the model last worked for this session (Infinity if never). */
  idleFor(): number {
    return this.lastActive ? Date.now() - this.lastActive : Infinity;
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
      system: this.systemFor(this.mode).length + this.sessionContext().length,
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
    this.failedCalls.clear();
    let nudges = 0;
    let cutoffs = 0;
    let changeNudged = false;
    const changeWanted = wantsChange(userInput);
    const fresh = needsFreshInfo(userInput);
    this.d.log?.event("run_start", { run: runId, mode: this.mode, model: config.model, chars: userInput.length, fresh });
    this.request = userInput;
    this.d.perms.setRequest?.(config.cwd, userInput);
    const pm = this.d.projectMemory;
    const note = pm ? userNote(userInput) : null;
    if (note) this.safely(() => pm!.noteAboutUser(note));
    // A correction of the last answer is a lesson for every later session.
    const previous = this.lastRequest;
    if (pm && previous && isCorrection(userInput)) this.safely(() => pm.feedback(previous, userInput));
    this.lastRequest = userInput;
    // "Where did we stop?" in a new session (after a crash or a dropped connection): the record of the
    // last work in this folder or its project comes with the request.
    let resumed: WorkRecord | null = null;
    if (pm && this.messages.length === 0 && isResumeRequest(userInput)) {
      try {
        resumed = pm.lastWork(config.cwd);
      } catch {
        resumed = null;
      }
    }
    const unfinished = resumed && resumed.outcome !== "completed" ? resumed : null;
    const now = new Date().toISOString();
    this.work = { cwd: config.cwd, request: resumed?.request ?? userInput, started: now, updated: now, outcome: "running", steps: [...(unfinished?.steps ?? [])], files: [...(unfinished?.files ?? [])] };
    this.workTouched = false;
    this.lookedAt = null;
    // Hints ride on the user message, not the system prompt: the system prompt and tool list stay
    // byte-identical between requests, so llama.cpp reuses its cache of them instead of re-reading.
    const design = wantsUi(userInput) ? uiHint(this.d.stack ?? [], fromImage(userInput)) : "";
    const extras = [resumed ? resumeNote(resumed) : "", design, fresh ? `(${FRESHNESS_HINT})` : ""].filter(Boolean);
    this.messages.push({ role: "user", content: [userInput, ...extras].join("\n\n") });
    this.status = { label: "Thinking", since: started, tokens: 0 };
    this.running = true;
    let runError: string | undefined;

    try {
      // Calls the model would make first, made now instead of spending a model turn deciding to:
      // "analyse the hype project" looks it over; "add Google sign-in to the Flutter app" checks the
      // current version and docs (the model's training data is older than the libraries).
      const byName = new Map(toolsForMode(this.d.tools, this.mode).map((t) => [t.name, t]));
      const overview = this.overviewTarget(userInput);
      const named = byName.has("read_file") ? namedFiles(userInput, config.cwd).map((f): [string, Args] => ["read_file", { path: f, limit: 150 }]) : [];
      const auto: [string, Args][] = [...(overview !== null ? [["project_overview", { path: overview }] as [string, Args]] : []), ...named, ...researchCalls(userInput, byName)];
      if (auto.length) {
        this.tellMode();
        const calls: ToolCall[] = auto.map(([name, args], i) => ({ id: `call_${Date.now()}_auto${i}`, name, arguments: JSON.stringify(args) }));
        this.messages.push({ role: "assistant", content: null, tool_calls: calls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })) });
        let outputs: string[] = [];
        try {
          ({ outputs } = await this.runCalls(calls, byName, repeats, signal, runId, result));
        } finally {
          calls.forEach((c, i) => this.messages.push({ role: "tool", tool_call_id: c.id, content: outputs[i] ?? "Error: the tool did not run." }));
        }
      }
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
        // A warm-up still running means a cold start: this request waits behind it.
        this.show(this.warming ? LOADING : "Thinking");
        await this.compact(signal);
        this.tellMode();
        const offered = toolsForMode(this.d.tools, this.mode);
        const byName = new Map(offered.map((t) => [t.name, t]));

        let streamed = 0;
        const turn = await llm.chat(
          this.conversation(),
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
        // The whole new file written in the reply instead of with write_file (a small-model habit):
        // save it, rather than spend minutes having the model write it again.
        if (turn.toolCalls.length === 0 && byName.has("write_file")) {
          const file = fileHandoff(turn.content, userInput, (p) => fs.existsSync(path.resolve(config.cwd, p)));
          if (file) {
            turn.toolCalls = [{ id: `call_${Date.now()}_file`, name: "write_file", arguments: JSON.stringify({ path: file.path, content: file.content }) }];
            turn.content = file.before;
          }
        }
        // "Let's run the tests again." with no call (a small-model habit): run them, with the
        // command used before in this session, or the project's. Same permission check as ever.
        if (turn.toolCalls.length === 0 && byName.has("bash") && RUN_TESTS.test(turn.content) && announcesAction(turn.content, true)) {
          const command = this.lastTest ?? this.d.testCommand;
          if (command) turn.toolCalls = [{ id: `call_${Date.now()}_tests`, name: "bash", arguments: JSON.stringify({ command }) }];
        }
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

        // Cut off at the length limit (MAX_REPLY_TOKENS): its tool calls are incomplete and its code
        // unfinished. Keep only the prose (the partial code would be re-read every turn) and ask for
        // the work in parts; twice at most, then the reply stands as it is.
        if (turn.truncated && cutoffs < 2 && !turn.toolCalls.some((c) => isJsonObject(c.arguments))) {
          cutoffs++;
          const prose = turn.content.split("```")[0].trim();
          this.messages.push({ role: "assistant", content: `${prose ? `${prose}\n` : ""}[reply cut off at the length limit]` });
          this.messages.push({ role: "user", content: LENGTH_NUDGE });
          this.d.log?.event("nudge", { run: runId, kind: "length", reply: turn.content.slice(0, 120) });
          continue;
        }
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
          // Asked for a change, nothing changed yet: small models describe the fix (or show the
          // code) instead of making it. One nudge to make it.
          const changed = result.calls.some((c) => c.ok && this.d.tools.find((t) => t.name === c.name)?.risk === "write");
          if (changeWanted && !changeNudged && nudges < MAX_NUDGES && !changed && offered.some((t) => t.risk === "write")) {
            changeNudged = true;
            nudges++;
            this.messages.push({ role: "user", content: CHANGE_NUDGE });
            this.d.log?.event("nudge", { run: runId, kind: "change", reply: turn.content.slice(0, 120) });
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
        // Progress resets the nudge budget: two nudges per stall, not per request.
        if (outputs.some((o) => !o.startsWith("Error:"))) nudges = 0;
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
      runError = err instanceof Error ? err.message : String(err);
      this.d.log?.event("run_error", { run: runId, error: runError });
      throw err;
    } finally {
      await this.finishWork(result, runError).catch((err) => this.d.log?.event("memory_error", { error: err instanceof Error ? err.message : String(err) }));
      stats.durationMs = Date.now() - started;
      this.running = false;
      this.lastActive = Date.now();
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
    const quiet = (p: Prepared) =>
      !p.failure && p.tool && (p.tool.risk === "safe" || p.tool.risk === "network") && needOf(p.tool, p.args!, { cwd: this.d.config.cwd, request: this.request }) === "none";
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
    this.safely(() => this.learnFrom(name, p, failure));
    this.safely(() => this.recordStep(`${view.label}(${view.target})`, p, failure));
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

  /**
   * Learning from mistakes: a call that failed, then a call of the same tool with other arguments
   * that worked, is remembered for every project and shown in later sessions' context. Retries with
   * the same arguments (a flaky network) teach nothing.
   */
  private learnFrom(name: string, p: Prepared, failure: ToolFailure | null): void {
    const args = p.args ? JSON.stringify(p.args) : p.call.arguments || "{}";
    if (failure) {
      if (failure.kind === "failed" || failure.kind === "invalid_args") this.failedCalls.set(name, { args, error: failure.message.split("\n")[0].slice(0, 200) });
      return;
    }
    const before = this.failedCalls.get(name);
    this.failedCalls.delete(name);
    if (!before || before.args === args) return;
    const lesson = `"${before.error}" with ${before.args.slice(0, 150)}; worked with ${args.slice(0, 150)}`;
    this.d.projectMemory?.lesson(name, lesson);
    if (!this.d.memory?.enabled) return;
    this.d.memory.remember({
      project: "*",
      kind: "lesson",
      key: name,
      value: lesson,
      source: "observed",
      confidence: 0.6,
      ttlDays: 180,
    });
  }

  /** Add a finished tool call to the record of this run's work and save it (a crash loses nothing). */
  private recordStep(step: string, p: Prepared, failure: ToolFailure | null): void {
    const pm = this.d.projectMemory;
    const w = this.work;
    if (!pm || !w) return;
    const cwd = this.d.config.cwd;
    if (p.tool?.name === "project_overview" && !failure) this.lookedAt = path.resolve(cwd, String(p.args?.path || "."));
    w.steps = [...w.steps, `${step} ${failure ? (failure.kind === "denied" ? "declined" : "failed") : "ok"}`].slice(-40);
    const target = p.args?.path ?? p.args?.file_path;
    if (!failure && p.tool?.risk === "write" && typeof target === "string") {
      const file = path.relative(cwd, path.resolve(cwd, target));
      if (!w.files.includes(file)) w.files = [...w.files, file].slice(-40);
    }
    w.updated = new Date().toISOString();
    this.workTouched = true;
    pm.saveWork(w, this.workDirs(w));
  }

  /** The folders the work belongs to: where ngobe runs, and each project it changed or looked at. */
  private workDirs(w: WorkRecord): string[] {
    const cwd = this.d.config.cwd;
    return [cwd, ...w.files.map((f) => projectRootOf(path.resolve(cwd, f))), ...(this.lookedAt ? [projectRootOf(this.lookedAt)] : [])];
  }

  /** At the end of a run that used tools: its outcome in the record, and a line in NGOBE.md per project. */
  private async finishWork(result: RunResult, error?: string): Promise<void> {
    const pm = this.d.projectMemory;
    const w = this.work;
    this.work = null;
    if (!pm || !w || !this.workTouched) return;
    Object.assign(w, { outcome: result.outcome, reply: result.text.slice(0, 600) || undefined, error, updated: new Date().toISOString() });
    pm.saveWork(w, this.workDirs(w));
    const cwd = this.d.config.cwd;
    const roots = w.files.length ? [...new Set(w.files.map((f) => projectRootOf(path.resolve(cwd, f))))] : [projectRootOf(this.lookedAt ?? cwd)];
    const request = w.request.length > 100 ? `${w.request.slice(0, 100)}…` : w.request;
    const did = w.files.length
      ? `changed ${w.files.slice(0, 5).join(", ")}${w.files.length > 5 ? ` +${w.files.length - 5} more` : ""}`
      : `looked into it (${result.stats.toolCalls} tool call${result.stats.toolCalls === 1 ? "" : "s"})`;
    const tests = result.stats.tests ? `; tests ${result.stats.tests}` : "";
    const end = { completed: "", cancelled: "; interrupted", error: "; stopped by an error", limit: "; stopped at a limit", declined: "; an action was declined" }[result.outcome];
    for (const root of roots) pm.logWork(root, `"${request}" → ${did}${tests}${end}`, await briefDescription(root).catch(() => ""));
  }

  /** Learn from shell results: whether tests passed, and which test/build commands work here. */
  private observeCommand(command: string, output: string, runId: string, result: RunResult): void {
    const code = Number(/^exit code (\d+)/.exec(output)?.[1] ?? NaN);
    if (!Number.isFinite(code)) return;
    const { memory, config } = this.d;
    const isTest = TEST_COMMAND.test(command);
    if (isTest) {
      result.stats.tests = code === 0 ? "passed" : "failed";
      if (command.length < 200 && !command.includes("\n")) this.lastTest = command;
    }
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
      request: this.request,
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
