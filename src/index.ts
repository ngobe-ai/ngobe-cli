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

  ui.info(`mugamba • model ${config.model} • ${config.baseURL}\n/help for commands, Ctrl+C to interrupt`);
  while (true) {
    let line: string;
    try {
      line = (await ui.ask("\n> ")).trim();
    } catch {
      break; // input closed
    }
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/clear") {
      agent.reset();
      ui.info("Conversation cleared.");
      continue;
    }
    if (line === "/help") {
      ui.info("/clear  reset the conversation\n/exit   quit");
      continue;
    }
    await runOnce(line);
  }
  ui.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
