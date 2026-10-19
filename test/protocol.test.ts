import { describe, expect, test } from "bun:test";
import { validateArgs } from "../src/tools/schema.js";
import { parseTextToolCalls, toTextMessages, visibleLength } from "../src/toolProtocol.js";
import type { Message } from "../src/types.js";

describe("argument validation", () => {
  const schema = {
    type: "object",
    properties: {
      path: { type: "string" },
      limit: { type: "integer", minimum: 1 },
      staged: { type: "boolean" },
      paths: { type: "array", items: { type: "string" } },
      kind: { type: "string", enum: ["a", "b"] },
    },
    required: ["path"],
  };

  test("coerces what small models send as strings", () => {
    const { args, errors } = validateArgs(schema, { path: "a.ts", limit: "20", staged: "true", paths: '["x","y"]' });
    expect(errors).toEqual([]);
    expect(args).toEqual({ path: "a.ts", limit: 20, staged: true, paths: ["x", "y"] });
  });

  test("reports missing, mistyped and out-of-range arguments", () => {
    const { errors } = validateArgs(schema, { limit: "many", kind: "c" });
    expect(errors).toContain('"path" is required');
    expect(errors).toContain('"limit" must be an integer');
    expect(errors.some((e) => e.startsWith('"kind" must be one of'))).toBe(true);
    expect(validateArgs(schema, { path: "a", limit: 0 }).errors).toContain('"limit" must be >= 1');
  });

  test("drops nulls sent for optional arguments", () => {
    expect(validateArgs(schema, { path: "a", limit: null }).args).toEqual({ path: "a" });
  });
});

describe("text tool-call protocol", () => {
  test("parses the JSON form", () => {
    const { content, calls } = parseTextToolCalls('Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_call>');
    expect(content).toBe("Let me look.");
    expect(calls).toEqual([{ name: "read_file", arguments: '{"path":"a.ts"}' }]);
  });

  test("parses the Qwen3-Coder XML form", () => {
    const text = "<tool_call>\n<function=grep>\n<parameter=pattern>\nfoo\\(\n</parameter>\n<parameter=glob>\nsrc/**\n</parameter>\n</function>\n</tool_call>";
    expect(parseTextToolCalls(text).calls).toEqual([{ name: "grep", arguments: JSON.stringify({ pattern: "foo\\(", glob: "src/**" }) }]);
  });

  test("keeps a malformed block as a call so the model hears about it", () => {
    const { calls } = parseTextToolCalls('<tool_call>{"name": "bash", "arguments": {"command": "ls"</tool_call>');
    expect(calls[0].name).toBe("bash");
    expect(() => JSON.parse(calls[0].arguments)).toThrow();
  });

  test("hides tool-call markup from streamed text, including a partial tag", () => {
    expect(visibleLength("hello <tool_call>{...}", false)).toBe(6);
    expect(visibleLength("hello <tool", false)).toBe(6);
    expect(visibleLength("hello <b>", false)).toBe(9);
    expect(visibleLength("hello <tool", true)).toBe(11);
  });

  test("rewrites native tool history as text, merging consecutive results", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "glob", arguments: '{"pattern":"*"}' } }, { id: "2", type: "function", function: { name: "grep", arguments: '{"pattern":"x"}' } }] },
      { role: "tool", tool_call_id: "1", content: "a.ts" },
      { role: "tool", tool_call_id: "2", content: "No matches." },
    ];
    const out = toTextMessages(messages);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(out[1].content).toContain('"name": "glob"');
    expect(out[2].content).toContain("a.ts");
    expect(out[2].content).toContain("No matches.");
  });
});
