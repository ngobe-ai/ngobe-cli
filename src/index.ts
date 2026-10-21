#!/usr/bin/env node
import { ConfigError, loadConfig, VERSION, type Command, type Config, type LoadedConfig } from "./config.js";
import { LineUi } from "./lineUi.js";
import { MODES, reviewRequest, runSlash, SLASH_COMMANDS } from "./slash.js";
import { isTrusted, trustFolder } from "./trust.js";
import { shouldKeepWarm } from "./warm.js";
import { yellow, type Ui } from "./ui.js";

/** Agent commands: the prompt template and the mode they force (null = use --mode / config). */
const AGENT_COMMANDS: Partial<Record<Command, { mode: Config["mode"] | null; prompt: (input: string, config: Config) => string | Promise<string> }>> = {
  ask: { mode: "ask", prompt: (q) => q },
  plan: { mode: "plan", prompt: (t) => t },
  code: { mode: null, prompt: (t) => t },
  fix: {
    mode: null,
    prompt: (p) =>
      `Fix this problem: ${p}\n\nReproduce it first if you can (run the failing test or command), make the smallest change that fixes the root cause, then run the relevant tests and report exactly what passed, failed or was not run.`,
  },
  review: { mode: "ask", prompt: (ref, config) => reviewRequest(config.cwd, ref, config.maxContextChars) },
};

/** After this long without a request, typing triggers another warm-up (cheap when still cached). */
const WARM_AFTER_IDLE_MS = 2 * 60_000;

async function main() {
  const loaded = loadConfig();
  for (const w of loaded.warnings) console.error(yellow(w));
  if (loaded.command && !AGENT_COMMANDS[loaded.command]) {
    const { runCommand } = await import("./commands.js");
    process.exitCode = await runCommand(loaded);
    return;
  }
  await runAgent(loaded);
}

async function runAgent(loaded: LoadedConfig) {
  const spec = loaded.command ? AGENT_COMMANDS[loaded.command] : undefined;
  const config: Config = spec?.mode ? { ...loaded.config, mode: spec.mode } : loaded.config;
  if (spec && !loaded.prompt && loaded.command !== "review") {
    console.error(`Usage: ngobe ${loaded.command} <${loaded.command === "ask" ? "question" : "task"}>`);
    process.exitCode = 2;
    return;
  }
  const prompt = spec ? await spec.prompt(loaded.prompt, config) : loaded.prompt;

  // Chat screen when interactive; plain line output for one-shot or piped use. The TUI
  // (ink + React) is only loaded when it is used.
  const interactive = !prompt && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const ui: Ui = interactive
    ? new (await import("./tui/tui.js")).Tui({ ...config, version: VERSION, commands: SLASH_COMMANDS })
    : new LineUi();

  // Like other coding agents: the first time in a folder, ask whether its files can be trusted
  // (AGENTS.md and custom agents there go into the model's context). One-shot runs don't ask.
  if (interactive && ui.trust && !isTrusted(config.cwd, config.stateDir)) {
    if (!(await ui.trust(config.cwd))) {
      await ui.close();
      return;
    }
    trustFolder(config.cwd, config.stateDir);
  }

  // Loaded here so --help and direct commands don't pay for the agent and SDK imports.
  const { createSession } = await import("./session.js");
  const session = await createSession(config, ui, { command: loaded.command ?? (prompt ? "prompt" : "repl") });
  const { agent, memory } = session;
  ui.onModeCycle?.(() => agent.setMode(MODES[(MODES.indexOf(agent.currentMode) + 1) % MODES.length]));
  // Once a day, in the background: say when a newer release is out (`ngobe upgrade` installs it).
  if (interactive) {
    void import("./update.js").then(async ({ dueForUpdateCheck, markUpdateChecked, updateNotice }) => {
      if (!dueForUpdateCheck(config.stateDir)) return;
      markUpdateChecked(config.stateDir);
      const notice = await updateNotice(loaded).catch(() => null);
      if (notice) ui.info(notice);
    });
  }

  let controller: AbortController | null = null;
  let lastUser = Date.now();
  // While the user reads the screen and types, have the server process the fixed prompt prefix
  // (about a minute from cold on a CPU), and again when they start typing after a break: Docker
  // Model Runner unloads a model after ~5 idle minutes, and its prompt cache with it. While they
  // are around, keep it loaded with the conversation cached (see warm.ts).
  if (!prompt && config.warmup) {
    void agent.warmup().then((ms) => {
      if (ms !== null && ms > 5_000 && agent.usage.runs === 0 && !controller) ui.info(`Model ready (warmed up in ${Math.round(ms / 1000)}s).`);
    });
    ui.onTyping?.(() => {
      lastUser = Date.now();
      if (!controller && agent.idleFor() > WARM_AFTER_IDLE_MS) void agent.warmup();
    });
    const keepWarm = setInterval(() => {
      if (shouldKeepWarm({ idleMs: agent.idleFor(), sinceUserMs: Date.now() - lastUser, busy: controller !== null, keepWarmMinutes: config.keepWarmMinutes })) {
        void agent.warmup();
      }
    }, 30_000);
    keepWarm.unref();
  }

  ui.onInterrupt(() => {
    if (!controller) return false;
    controller.abort(); // Ctrl+C cancels the current run
    return true;
  });

  let failed = false;
  const runOnce = async (input: string) => {
    lastUser = Date.now();
    controller = new AbortController();
    try {
      // An interrupted run says so in its summary line ("Interrupted after 12s").
      const result = await agent.run(input, controller.signal);
      failed = result.outcome !== "completed";
    } catch (err) {
      failed = true;
      if (!controller.signal.aborted) ui.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      controller = null;
    }
  };

  // One-shot mode: ngobe "fix the failing test"
  if (prompt) {
    await runOnce(prompt);
    await session.mcp?.close();
    await ui.close();
    memory?.close();
    if (failed) process.exitCode = 1;
    return;
  }

  while (true) {
    let input: string;
    try {
      input = (await ui.ask()).trim();
    } catch {
      break; // input closed
    }
    if (!input) continue;
    // "/…" is a command, except paths like /usr/bin/foo pasted as a message.
    if (/^\/[a-z-]+(\s|$)/i.test(input)) {
      const result = await runSlash(input, {
        config,
        session,
        ui,
        abortable: async (fn) => {
          controller = new AbortController();
          try {
            return await fn(controller.signal);
          } catch (err) {
            if (!controller.signal.aborted) throw err;
            ui.warn("Interrupted.");
            return undefined;
          } finally {
            controller = null;
          }
        },
      }).catch((err) => {
        ui.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        return { kind: "done" as const };
      });
      if (result.kind === "exit") break;
      if (result.kind === "prompt") await runOnce(result.text);
      continue;
    }
    await runOnce(input);
  }
  await session.mcp?.close();
  await ui.close();
  memory?.close();
}

main().catch((err) => {
  if (err instanceof ConfigError || (err instanceof TypeError && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS"))) {
    console.error(err.message);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
