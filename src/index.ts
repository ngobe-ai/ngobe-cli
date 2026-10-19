#!/usr/bin/env node
import { ConfigError, loadConfig, type Command, type Config, type LoadedConfig } from "./config.js";
import { LineUi } from "./lineUi.js";
import { yellow, type Ui } from "./ui.js";

/** Agent commands: the prompt template and the mode they force (null = use --mode / config). */
const AGENT_COMMANDS: Partial<Record<Command, { mode: Config["mode"] | null; prompt: (input: string) => string }>> = {
  ask: { mode: "ask", prompt: (q) => q },
  plan: { mode: "plan", prompt: (t) => t },
  code: { mode: null, prompt: (t) => t },
  fix: {
    mode: null,
    prompt: (p) =>
      `Fix this problem: ${p}\n\nReproduce it first if you can (run the failing test or command), make the smallest change that fixes the root cause, then run the relevant tests and report exactly what passed, failed or was not run.`,
  },
  review: {
    mode: "ask",
    prompt: (ref) =>
      `Review the code changes ${ref ? `since ${ref} (git_diff with ref=${ref})` : "in the working tree (git_status, then git_diff and git_diff with staged=true)"}. Report bugs, security problems, missing tests and risky changes, each with file:line and why it matters. Do not modify files.`,
  },
};

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
  const prompt = spec ? spec.prompt(loaded.prompt) : loaded.prompt;

  // Chat screen when interactive; plain line output for one-shot or piped use. The TUI
  // (ink + React) is only loaded when it is used.
  const interactive = !prompt && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const ui: Ui = interactive ? new (await import("./tui/tui.js")).Tui(config) : new LineUi();
  // Loaded here so --help and direct commands don't pay for the agent and SDK imports.
  const { createSession } = await import("./session.js");
  const { agent, memory } = await createSession(config, ui, { command: loaded.command ?? (prompt ? "prompt" : "repl") });

  let controller: AbortController | null = null;
  ui.onInterrupt(() => {
    if (!controller) return false;
    controller.abort(); // Ctrl+C cancels the current run
    return true;
  });

  let failed = false;
  const runOnce = async (input: string) => {
    controller = new AbortController();
    try {
      const result = await agent.run(input, controller.signal);
      if (controller.signal.aborted) ui.warn("\nInterrupted."); // cancelled during a tool, so run() returned
      failed = result.outcome !== "completed";
    } catch (err) {
      failed = true;
      if (controller.signal.aborted) ui.warn("\nInterrupted.");
      else ui.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      controller = null;
    }
  };

  // One-shot mode: ngobe "fix the failing test"
  if (prompt) {
    await runOnce(prompt);
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
    if (input === "/exit" || input === "/quit") break;
    if (input === "/clear") {
      agent.reset();
      ui.info("Conversation cleared.");
      continue;
    }
    if (input === "/help") {
      ui.info(
        [
          "/clear  reset the conversation",
          "/exit   quit (Ctrl+C at an empty prompt also quits)",
          "",
          `mode: ${config.mode} (start with --mode ask|plan|edit|auto to change)`,
          "enter send · paste for multi-line input",
          "up/down recall history · PgUp/PgDn scroll the transcript",
        ].join("\n"),
      );
      continue;
    }
    await runOnce(input);
  }
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
