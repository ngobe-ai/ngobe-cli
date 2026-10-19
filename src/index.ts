#!/usr/bin/env node
import { Agent } from "./agent.js";
import { loadConfig } from "./config.js";
import { buildSystemPrompt, loadProjectInstructions } from "./context.js";
import { LLM } from "./llm.js";
import { Permissions } from "./permissions.js";
import { tools } from "./tools/index.js";
import { LineUi } from "./lineUi.js";
import { Tui } from "./tui/tui.js";
import type { Ui } from "./ui.js";

async function main() {
  const { config, prompt } = loadConfig();
  // Chat screen when interactive; plain line output for one-shot or piped use.
  const interactive = !prompt && process.stdin.isTTY === true && process.stdout.isTTY === true;
  const ui: Ui = interactive ? new Tui(config) : new LineUi();
  const instructions = await loadProjectInstructions(config.cwd);
  const agent = new Agent({
    config,
    llm: new LLM(config),
    tools,
    ui,
    perms: new Permissions(ui, config.yolo),
    systemPrompt: buildSystemPrompt(config.cwd, instructions),
  });

  let controller: AbortController | null = null;
  ui.onInterrupt(() => {
    if (!controller) return false;
    controller.abort(); // Ctrl+C cancels the current run
    return true;
  });

  const runOnce = async (input: string) => {
    controller = new AbortController();
    try {
      await agent.run(input, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) ui.warn("\nInterrupted.");
      else ui.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      controller = null;
    }
  };

  // One-shot mode: agent "fix the failing test"
  if (prompt) {
    await runOnce(prompt);
    await ui.close();
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
          "enter send · paste for multi-line input",
          "up/down recall history · PgUp/PgDn scroll the transcript",
        ].join("\n"),
      );
      continue;
    }
    await runOnce(input);
  }
  await ui.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
