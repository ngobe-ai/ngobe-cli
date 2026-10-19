#!/usr/bin/env node
import { Agent } from "./agent.js";
import { loadConfig } from "./config.js";
import { buildSystemPrompt, loadProjectInstructions } from "./context.js";
import { LLM } from "./llm.js";
import { Permissions } from "./permissions.js";
import { tools } from "./tools/index.js";
import { UI } from "./ui.js";

async function main() {
  const { config, prompt } = loadConfig();
  const ui = new UI();
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
    if (controller) controller.abort(); // Ctrl+C cancels the current run
    else {
      ui.close();
      process.exit(0);
    }
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
    ui.close();
    return;
  }

  ui.banner(config);
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
          "/exit   quit (Ctrl+D also works)",
          "",
          "end a line with \\ to write multiple lines",
          "up/down arrows recall previous prompts",
        ].join("\n"),
      );
      continue;
    }
    await runOnce(input);
  }
  ui.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
