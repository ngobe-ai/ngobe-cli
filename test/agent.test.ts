import { describe, expect, test } from "bun:test";
import path from "node:path";
import { Agent } from "../src/agent.js";
import type { Config } from "../src/config.js";
import { trimHistory } from "../src/context.js";
import type { LLM } from "../src/llm.js";
import type { Permissions } from "../src/permissions.js";
import type { Message, Tool } from "../src/types.js";
import type { Ui } from "../src/ui.js";

describe("agent", () => {
  test("does not run a tool approved after the run was cancelled", async () => {
    const controller = new AbortController();
    let ran = false;
    const tool: Tool = {
      name: "write_file",
      description: "",
      parameters: {},
      risk: "write",
      run: async () => {
        ran = true;
        return "ok";
      },
    };
    const llm = {
      chat: async () => ({ content: "", toolCalls: [{ id: "1", name: "write_file", arguments: "{}" }] }),
    } as unknown as LLM;
    // The user pressed Ctrl+C while the y/n prompt was open, then answered "y".
    const perms = {
      check: async () => {
        controller.abort();
        return true;
      },
    } as unknown as Permissions;
    const noop = () => {};
    const ui = { write: noop, endTurn: noop, tool: noop, info: noop, warn: noop, error: noop } as unknown as Ui;
    const agent = new Agent({
      config: { maxTurns: 5, cwd: "." } as Config,
      llm,
      tools: [tool],
      ui,
      perms,
      systemPrompt: "",
    });

    await agent.run("go", controller.signal);
    expect(ran).toBe(false);
  });
});

describe("trimHistory", () => {
  const conversation = (): Message[] => [
    { role: "user", content: "write it" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "1",
          type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: "a.txt", content: "x".repeat(5000) }) },
        },
      ],
    },
    { role: "tool", tool_call_id: "1", content: "y".repeat(5000) },
    { role: "user", content: "next" },
  ];

  test("blanks old tool output", () => {
    const messages = conversation();
    (messages[1] as { tool_calls: { function: { arguments: string } }[] }).tool_calls[0].function.arguments = "{}";
    trimHistory(messages, 1000);
    expect(messages[2].content).toBe("[older tool output removed to save context]");
  });

  test("counts and blanks large tool-call arguments", () => {
    const messages = conversation();
    messages[2].content = "ok";
    trimHistory(messages, 1000);
    const call = (messages[1] as { tool_calls: { function: { arguments: string } }[] }).tool_calls[0];
    expect(call.function.arguments.length).toBeLessThan(300);
    expect(() => JSON.parse(call.function.arguments)).not.toThrow();
  });
});

describe("config", () => {
  test.each(["MUGAMBA_MAX_TURNS", "MUGAMBA_MAX_CONTEXT_CHARS"])("rejects a non-numeric %s", (name) => {
    const proc = Bun.spawnSync(["bun", "src/index.ts", "hi"], {
      cwd: path.join(import.meta.dir, ".."),
      env: { ...process.env, [name]: "abc" },
    });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain(name);
  });
});
