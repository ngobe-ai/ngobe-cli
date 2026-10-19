import { execFile } from "node:child_process";
import path from "node:path";
import { createAgentFile } from "./agents.js";
import { configFilePath, redactedConfig, saveSetting, VERSION, type Config, type Mode } from "./config.js";
import { toolsForMode } from "./permissions.js";
import { gitDiff, gitStatus } from "./tools/git.js";
import type { Session } from "./session.js";
import { formatDuration, formatTokens, type Ui } from "./ui.js";

/**
 * Slash commands in the chat, the set other coding agents (Claude Code, Codex) have, with the
 * same behaviour. A command either does its job right away or turns into a request for the
 * agent (/init, /review).
 */

export interface SlashCommand {
  name: string;
  aliases?: string[];
  /** Shown after the name in /help and the completion menu, e.g. "[name|number]". */
  args?: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "Commands and keys" },
  { name: "clear", aliases: ["new", "reset"], description: "Start a new conversation (clears context and screen)" },
  { name: "compact", args: "[focus]", description: "Summarize the conversation to free up context" },
  { name: "model", args: "[name|number]", description: "List the server's models, or switch (saved as default)" },
  { name: "mode", args: "[ask|plan|edit|auto]", description: "Show or switch the permission mode (shift+tab cycles)" },
  { name: "permissions", aliases: ["approvals"], description: "What runs without asking; what you allowed this session" },
  { name: "agents", aliases: ["subagents"], args: "[new <name>]", description: "List sub-agents, or create a custom one" },
  { name: "init", description: "Write AGENTS.md: a guide to this project for the agent" },
  { name: "review", args: "[git ref]", description: "Review uncommitted changes (or changes since a ref)" },
  { name: "diff", description: "Show uncommitted changes (git diff)" },
  { name: "status", description: "Version, model, server, mode and session" },
  { name: "context", description: "How full the context window is" },
  { name: "cost", aliases: ["usage"], description: "Tokens and time used this session" },
  { name: "todos", description: "The current todo list" },
  { name: "tools", description: "Tools the agent can use in this mode" },
  { name: "memory", description: "What ngobe remembers about this project" },
  { name: "config", description: "Effective settings (secrets hidden) and the config file" },
  { name: "exit", aliases: ["quit"], description: "Quit ngobe" },
];

export const MODES: Mode[] = ["edit", "auto", "plan", "ask"];

/**
 * The review request with the changes already attached: a small model then reviews straight
 * away instead of spending a slow turn (or a failed tool call) fetching the diff. Built with
 * the git tools, so refs are validated and secret files are left out.
 */
export async function reviewRequest(cwd: string, ref: string, budgetChars: number): Promise<string> {
  const ctx = { cwd };
  const status = await gitStatus.run({}, ctx).catch(() => null);
  if (status === null) return "Review the code changes in this project. It is not a git repository: ask the user which files to review. Do not modify files.";
  let diff: string;
  if (ref) diff = await gitDiff.run({ ref }, ctx);
  else {
    // Staged and unstaged together; a repository without commits yet has no HEAD.
    diff = await gitDiff.run({ ref: "HEAD" }, ctx).catch(async () => [await gitDiff.run({ staged: true }, ctx), await gitDiff.run({}, ctx)].join("\n"));
  }
  const limit = Math.max(2_000, Math.floor(budgetChars / 2));
  const shown = diff.length > limit ? `${diff.slice(0, limit)}\n[diff truncated: ${diff.length - limit} more characters; read the rest with git_diff and a path]` : diff;
  return `Review the code changes ${ref ? `since ${ref}` : "in the working tree (uncommitted, staged and unstaged)"}. Report bugs, security problems, missing tests and risky changes, each with file:line and why it matters; read files for context where needed. Do not modify files.

git status:
${status.trim()}

Diff:
\`\`\`diff
${shown.trim() || "(no differences)"}
\`\`\``;
}

const INIT_PROMPT = `Analyze this codebase and create an AGENTS.md file at the project root (if one exists, improve it instead). It is read by coding agents working here, so keep it short and specific to this project:
- the commands to build, test (including running a single test), lint and run it
- the architecture: the main directories and what lives where, as much as is needed to find one's way
- code style and conventions that are not obvious from a single file, and anything surprising
Look at the manifests, README, CI config and existing agent instructions (CLAUDE.md, .cursor/rules, .github/copilot-instructions.md) first. Don't invent anything you have not seen in the code; no generic advice.`;

export type SlashResult = { kind: "done" } | { kind: "prompt"; text: string } | { kind: "exit" };

export interface SlashEnv {
  config: Config;
  session: Session;
  ui: Ui;
  /** Run something the user can interrupt (Esc / Ctrl+C); undefined when interrupted. */
  abortable<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined>;
}

export function findCommand(name: string): SlashCommand | undefined {
  const n = name.toLowerCase();
  return SLASH_COMMANDS.find((c) => c.name === n || c.aliases?.includes(n));
}

/** Handle one "/…" line. */
export async function runSlash(line: string, env: SlashEnv): Promise<SlashResult> {
  const [word, ...rest] = line.slice(1).trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  const cmd = findCommand(word ?? "");
  const { ui, session, config } = env;
  const { agent } = session;
  const done: SlashResult = { kind: "done" };
  if (!cmd) {
    ui.warn(`Unknown command /${word}. /help lists the commands.`);
    return done;
  }

  switch (cmd.name) {
    case "help": {
      const width = Math.max(...SLASH_COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ""}`.length));
      ui.info(
        [
          ...SLASH_COMMANDS.map((c) => `${`/${c.name}${c.args ? ` ${c.args}` : ""}`.padEnd(width)}  ${c.description}${c.aliases ? ` (also /${c.aliases.join(", /")})` : ""}`),
          "",
          "keys: enter send · esc interrupt · shift+tab cycle mode · ↑/↓ history · PgUp/PgDn or shift+↑/↓ scroll · Ctrl+C twice quits",
          "shell: ngobe doctor (check the setup) · ngobe update · ngobe --help",
        ].join("\n"),
      );
      return done;
    }

    case "clear":
      agent.reset();
      session.perms.revokeAll();
      ui.clear?.();
      ui.info("New conversation. Context cleared.");
      return done;

    case "compact": {
      const before = agent.contextUsage();
      ui.activity({ label: "Compacting the conversation", since: Date.now(), tokens: 0 });
      try {
        const compacted = await env.abortable((signal) => agent.compactNow(signal, arg));
        if (compacted === undefined) return done; // interrupted
        if (!compacted) ui.info("Nothing to compact yet.");
        else {
          const after = agent.contextUsage();
          ui.info(`Compacted: conversation ${chars(before.history + before.summary)} → ${chars(after.history + after.summary)} (summary kept in context).`);
        }
      } finally {
        ui.activity(null);
      }
      return done;
    }

    case "model": {
      let models: string[];
      try {
        models = (await session.llm.models()).map((m) => m.id);
      } catch (err) {
        ui.error(`Could not list models: ${err instanceof Error ? err.message : String(err)}`);
        return done;
      }
      if (!arg) {
        ui.info(
          [
            `Model: ${config.model}`,
            "",
            ...models.map((m, i) => `${m === config.model ? "●" : " "} ${i + 1}. ${m}`),
            "",
            "Switch with /model <number or name>.",
          ].join("\n"),
        );
        return done;
      }
      const n = Number(arg);
      const choice = Number.isInteger(n) && n >= 1 && n <= models.length ? models[n - 1] : (models.find((m) => m === arg) ?? models.find((m) => m.includes(arg)));
      if (!choice) {
        ui.warn(`No model matches "${arg}". /model lists them.`);
        return done;
      }
      config.model = choice; // the LLM client reads it on every request
      ui.modelChanged?.(choice);
      let saved = "";
      try {
        saved = ` Saved as the default in ${tildePath(saveSetting("model", choice))}.`;
      } catch (err) {
        saved = ` (Not saved: ${err instanceof Error ? err.message : String(err)})`;
      }
      const envOverride = process.env.NGOBE_MODEL || process.env.MUGAMBA_MODEL ? " NGOBE_MODEL is set in your environment and wins over the saved default." : "";
      ui.info(`Model: ${choice}.${saved}${envOverride}`);
      return done;
    }

    case "mode": {
      if (!arg) {
        ui.info(`Mode: ${agent.currentMode}. ${MODE_HELP[agent.currentMode]}\nSwitch with /mode ask|plan|edit|auto, or shift+tab.`);
        return done;
      }
      const mode = MODES.find((m) => m === arg.toLowerCase());
      if (!mode) {
        ui.warn(`Unknown mode "${arg}": use ask, plan, edit or auto.`);
        return done;
      }
      agent.setMode(mode);
      ui.info(`Mode: ${mode}. ${MODE_HELP[mode]}`);
      return done;
    }

    case "permissions": {
      const { tools, commands } = session.perms.approvals;
      ui.info(
        [
          `Mode: ${agent.currentMode}. ${MODE_HELP[agent.currentMode]}`,
          "Always ask: dangerous commands (rm -rf, sudo, force-push …), secret files (.env, keys), git commits and pushes.",
          `Allowed this session: ${[...tools, ...commands.map((c) => `bash: ${c} …`)].join(", ") || "nothing yet (answer a to a prompt to allow it for the session)"}`,
          "/clear forgets them.",
        ].join("\n"),
      );
      return done;
    }

    case "agents": {
      if (rest[0] === "new") {
        const name = rest[1] ?? "";
        try {
          const file = createAgentFile(config.cwd, name);
          ui.info(`Created ${path.relative(config.cwd, file)}. Edit its description, tools and instructions, then restart ngobe to use it.`);
        } catch (err) {
          ui.warn(err instanceof Error ? err.message : String(err));
        }
        return done;
      }
      const offered = session.tools.some((t) => t.name === "task");
      ui.info(
        [
          "Sub-agents work on one task in a fresh context and return a single report.",
          "",
          ...session.agents.map((a) => `• ${a.name} (${a.source}${a.tools ? `; tools: ${a.tools.join(", ")}` : ""}): ${a.description}`),
          "",
          offered
            ? "The agent hands work to them with the task tool."
            : `Off with the lean tool profile until you add a custom agent (/agents new <name>), or set "toolProfile": "full". Each sub-agent re-reads its prompt, which is slow on a CPU server.`,
          "Custom agents: .ngobe/agents/*.md in the project, ~/.config/ngobe/agents/*.md for all projects (.claude/agents works too).",
        ].join("\n"),
      );
      return done;
    }

    case "init":
      return { kind: "prompt", text: INIT_PROMPT };

    case "review":
      return { kind: "prompt", text: await reviewRequest(config.cwd, arg, config.maxContextChars) };

    case "diff": {
      const stat = await git(config.cwd, ["diff", "HEAD", "--stat"]);
      if (stat === null) {
        ui.warn("Not a git repository (or git is not installed).");
        return done;
      }
      if (!stat.trim()) {
        ui.info("No uncommitted changes.");
        return done;
      }
      const diff = (await git(config.cwd, ["diff", "HEAD", "--no-color"])) ?? "";
      const lines = diff.split("\n");
      ui.info(`${stat.trimEnd()}\n\n${lines.slice(0, 200).join("\n")}${lines.length > 200 ? `\n… ${lines.length - 200} more lines (git diff)` : ""}`);
      return done;
    }

    case "status": {
      const u = agent.usage;
      ui.info(
        [
          `ngobe ${VERSION}`,
          `model     ${config.model}`,
          `server    ${config.baseURL}`,
          `mode      ${agent.currentMode}`,
          `cwd       ${tildePath(config.cwd)}`,
          `tools     ${session.tools.length} (${config.toolProfile} profile, ${config.toolMode} tool calling)`,
          `memory    ${session.memory?.enabled ? "on" : "off"}`,
          `session   ${u.runs} request${u.runs === 1 ? "" : "s"} · ${formatTokens(u.tokensIn + u.tokensOut)} tokens`,
        ].join("\n"),
      );
      return done;
    }

    case "context": {
      const c = agent.contextUsage();
      const used = c.system + c.tools + c.history + c.summary;
      const pct = Math.min(100, Math.round((used / c.budget) * 100));
      const bar = "█".repeat(Math.round(pct / 5)).padEnd(20, "░");
      ui.info(
        [
          `${bar} ${pct}% of ~${tok(c.budget)} tokens (maxContextChars ${c.budget})`,
          `system prompt  ${tok(c.system)}`,
          `tools          ${tok(c.tools)}  (${toolsForMode(session.tools, agent.currentMode).length} tools)`,
          `conversation   ${tok(c.history)}`,
          ...(c.summary ? [`summary        ${tok(c.summary)}`] : []),
          "Older tool output is trimmed, then summarized, as it fills up. /compact does it now.",
        ].join("\n"),
      );
      return done;
    }

    case "cost": {
      const u = agent.usage;
      ui.info(
        `This session: ${u.runs} request${u.runs === 1 ? "" : "s"} · ${formatTokens(u.tokensIn)} tokens in · ${formatTokens(u.tokensOut)} out · ${u.toolCalls} tool calls · ${formatDuration(u.ms)} working.\nYour own server: no per-token cost.`,
      );
      return done;
    }

    case "todos": {
      const list = agent.todos;
      ui.info(list.length ? list.map((t) => `${t.status === "completed" ? "☒" : t.status === "in_progress" ? "◐" : "☐"} ${t.content}`).join("\n") : "No todos.");
      return done;
    }

    case "tools": {
      const offered = toolsForMode(session.tools, agent.currentMode);
      ui.info([`${offered.length} tools in ${agent.currentMode} mode (${config.toolProfile} profile):`, ...offered.map((t) => `• ${t.name}: ${t.description.split(/(?<=\.)\s/)[0]}`)].join("\n"));
      return done;
    }

    case "memory": {
      const memory = session.memory;
      if (!memory?.enabled) {
        ui.info("Memory is off (NGOBE_MEMORY=0).");
        return done;
      }
      const facts = memory.listFacts(config.cwd);
      ui.info(
        facts.length
          ? [`${facts.length} remembered for this project:`, ...facts.map((f) => `• ${f.kind} ${f.key}: ${f.value} (${f.source})`), "Manage with: ngobe memory list|delete|clear"].join("\n")
          : "Nothing remembered for this project yet.",
      );
      return done;
    }

    case "config":
      ui.info(
        `${tildePath(configFilePath())}\n${Object.entries(redactedConfig(config))
          .filter(([, v]) => v !== undefined && typeof v !== "object")
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")}`,
      );
      return done;

    case "exit":
      return { kind: "exit" };
  }
  return done;
}

export const MODE_HELP: Record<Mode, string> = {
  ask: "Answers only; no changes, no commands.",
  plan: "Read-only: explores, then proposes a plan for you to approve.",
  edit: "Asks before every file change and command.",
  auto: "Low-risk changes and commands run without asking; risky ones still ask.",
};

function chars(n: number): string {
  return `${tok(n)} tokens`;
}

/** Characters → approximate tokens, for display. */
function tok(n: number): string {
  return `${formatTokens(Math.round(n / 4))}`;
}

function tildePath(p: string): string {
  const home = process.env.HOME ?? "";
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}
