import { describe, expect, test } from "bun:test";
import { validateArgs } from "../src/tools/schema.js";
import { fileHandoff, parseTextToolCalls, toTextMessages, visibleLength } from "../src/toolProtocol.js";
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

describe("looser tool-call shapes (Qwen2.5-Coder and similar)", () => {
  const known = ["read_file", "bash", "grep"];

  test.each([
    ["fenced as xml", '```xml\n{"name": "read_file", "arguments": {"path": "README.md"}}\n```'],
    ["fenced as json", 'I will read it.\n```json\n{"name": "read_file", "arguments": {"path": "README.md"}}\n```'],
    ["<function> wrapper", '<function>\n {"name": "read_file", "arguments": {"path": "README.md"}}\n</function>'],
    ["unterminated <function>", '<function>\n {"name": "read_file", "arguments": {"path": "README.md"}}'],
    ["<tools> wrapper", '<tools>{"name": "read_file", "arguments": {"path": "README.md"}}</tools>'],
    ["the whole reply", '{"name": "read_file", "arguments": {"path": "README.md"}}'],
    ["OpenAI-style function object", '{"function": {"name": "read_file", "arguments": {"path": "README.md"}}}'],
  ])("%s", (_label, text) => {
    expect(parseTextToolCalls(text, known).calls).toEqual([{ name: "read_file", arguments: '{"path":"README.md"}' }]);
  });

  test("nested braces and braces inside strings", () => {
    const text = '```json\n{"name": "bash", "arguments": {"command": "echo \\"{not json}\\" && ls"}}\n```';
    expect(parseTextToolCalls(text, known).calls).toEqual([{ name: "bash", arguments: JSON.stringify({ command: 'echo "{not json}" && ls' }) }]);
  });

  test("several fenced calls", () => {
    const text = '```json\n{"name": "grep", "arguments": {"pattern": "a"}}\n```\n```json\n{"name": "grep", "arguments": {"pattern": "b"}}\n```';
    expect(parseTextToolCalls(text, known).calls.map((c) => c.arguments)).toEqual(['{"pattern":"a"}', '{"pattern":"b"}']);
  });

  test("the prose before a call is kept as the reply", () => {
    expect(parseTextToolCalls('Let me check.\n```json\n{"name": "grep", "arguments": {"pattern": "x"}}\n```', known).content).toBe("Let me check.");
  });

  test.each([
    ["an unknown tool name", '```json\n{"name": "delete_everything", "arguments": {}}\n```'],
    ["ordinary JSON in an answer", '```json\n{"version": "1.2.3", "name": "my-package"}\n```'],
    ["no tool list given", '```json\n{"name": "read_file", "arguments": {}}\n```'],
  ])("not a call: %s", (label, text) => {
    expect(parseTextToolCalls(text, label === "no tool list given" ? undefined : known).calls).toEqual([]);
  });

  test("hides a <function> call from streamed text", () => {
    expect(visibleLength("Sure. <function>\n{", false)).toBe(6);
    expect(visibleLength("Sure. <func", false)).toBe(6);
  });
});

describe("holding back text-mode tool calls while streaming", () => {
  test.each([
    ['{"name": "grep"', 0],
    ['  {"name"', 0],
    ["Let me look.\n```json\n{", 13],
    ["Let me look.\n{", 13],
    ["Let me look.\nread_file\n", 13],
    ["Let me look.\nread_file\n{", 13],
    ["Let me look.\nbash\nls is next.", 29],
    ["The answer is 42.", 17],
  ])("%p shows %p characters", (text, shown) => {
    expect(visibleLength(text, false, true)).toBe(shown);
  });

  test("without holding back, JSON streams as usual", () => {
    expect(visibleLength('{"a": 1}', false)).toBe(8);
  });
});

describe("tool calls a small model writes in prose", () => {
  const known = ["glob", "read_file", "bash"];
  const screenshot =
    "To understand the project, I'll start by exploring its structure:\n\n1. **Project Root**: `/Users/bruno/me/COTE`.\n\n```bash\n" +
    '{"name": "glob", "arguments": {"pattern": "**/*"}}\n```\n\nPlease review the list of files provided by the `glob` function before proceeding.';

  test("a JSON call in a fence of any language is a call; the prose after it is dropped", () => {
    const { content, calls } = parseTextToolCalls(screenshot, known);
    expect(calls).toEqual([{ name: "glob", arguments: '{"pattern":"**/*"}' }]);
    expect(content).toBe("To understand the project, I'll start by exploring its structure:\n\n1. **Project Root**: `/Users/bruno/me/COTE`.");
  });

  test("a JSON call on its own line after some prose is a call", () => {
    const { content, calls } = parseTextToolCalls('Let me look.\n{"name": "read_file", "arguments": {"path": "a.ts"}}', known);
    expect(calls).toEqual([{ name: "read_file", arguments: '{"path":"a.ts"}' }]);
    expect(content).toBe("Let me look.");
  });

  test("arguments under a fence named after a tool are a call to that tool", () => {
    const reply =
      "I apologize for the confusion. Let's list the files and directories within the `inspire_africa` folder using the `ls` command.\n\n" +
      '```bash\n{\n  "command": "ls /Users/bruno/me/COTE/inspire_africa"\n}\n```';
    const { content, calls } = parseTextToolCalls(reply, known);
    expect(calls).toEqual([{ name: "bash", arguments: '{"command":"ls /Users/bruno/me/COTE/inspire_africa"}' }]);
    expect(content).toBe("I apologize for the confusion. Let's list the files and directories within the `inspire_africa` folder using the `ls` command.");
  });

  test("arguments under a line naming a tool are a call to that tool", () => {
    const { content, calls } = parseTextToolCalls('Let me read it.\nread_file\n{"path": "src/a.ts"}', known);
    expect(calls).toEqual([{ name: "read_file", arguments: '{"path":"src/a.ts"}' }]);
    expect(content).toBe("Let me read it.");
  });

  test("a command the reply says it will run with bash is run", () => {
    // Seen live: the model said this twice and stopped both times.
    const reply = "To confirm the version of Flutter installed on your machine, I'll use the bash tool to run the `flutter --version` command.";
    expect(parseTextToolCalls(reply, known)).toEqual({ content: reply, calls: [{ name: "bash", arguments: '{"command":"flutter --version"}' }] });
    const named = "Let me run `npm test` to see what fails.";
    expect(parseTextToolCalls(named, known).calls).toEqual([{ name: "bash", arguments: '{"command":"npm test"}' }]);
    const toolInTicks = "I'll use the `bash` tool to run `ls -la`.";
    expect(parseTextToolCalls(toolInTicks, known).calls).toEqual([{ name: "bash", arguments: '{"command":"ls -la"}' }]);
  });

  test("commands suggested to the user, already run, or meant for another tool stay text", () => {
    for (const text of [
      "You can run `flutter upgrade` to update, or `flutter doctor` to check your setup.",
      "I ran `flutter --version`: 3.47.7 is installed.",
      "Let me know if you want me to run `npm test`.",
      "I'll use read_file to read `src/a.ts` next.",
      "I'll run `npm test` and `npm run build`.",
    ]) {
      expect(parseTextToolCalls(text, known)).toEqual({ content: text, calls: [] });
    }
  });

  test("a file written in the reply instead of with write_file is saved as the file the request named", () => {
    // Seen live: "Reproduce this UI as login.html" → the whole page in a ```html block, no tool call.
    const reply =
      "To reproduce the UI as `login.html`, I'll create a single HTML file with embedded CSS. Here's the complete file:\n\n```html\n<!DOCTYPE html>\n<html lang=\"en\">\n<body>\n  <h1>Welcome back</h1>\n</body>\n</html>\n```\n\nTo see the login page, open this HTML file in a web browser.";
    const none = () => false;
    expect(fileHandoff(reply, "Reproduce this UI as login.html: /tmp/login-mockup.png", none)).toEqual({
      path: "login.html",
      content: '<!DOCTYPE html>\n<html lang="en">\n<body>\n  <h1>Welcome back</h1>\n</body>\n</html>\n',
      before: "To reproduce the UI as `login.html`, I'll create a single HTML file with embedded CSS. Here's the complete file:",
    });
    // The file the reply names counts too, when the request names none.
    expect(fileHandoff(reply, "reproduce this mockup as a web page", none)?.path).toBe("login.html");
  });

  test("no handoff without a new file named, with an existing file, or with several or unfinished blocks", () => {
    const one = "Here it is:\n```html\n<p>a</p>\n<p>b</p>\n<p>c</p>\n```";
    const none = () => false;
    expect(fileHandoff(one, "how do I build a login page?", none)).toBeNull();
    expect(fileHandoff(one, "rewrite index.html", (p) => p === "index.html")).toBeNull();
    expect(fileHandoff(`${one}\n${one}`, "create page.html", none)).toBeNull();
    expect(fileHandoff("Here:\n```html\n<p>a</p>\n<p>b</p>\n<p>c", "create page.html", none)).toBeNull();
    expect(fileHandoff("```css\nbody{}\na{}\np{}\n```", "create page.html", none)).toBeNull(); // CSS is not page.html
  });

  test("a JSON object under a label that isn't a tool stays text", () => {
    const json = 'The payload:\n```json\n{"command": "ls"}\n```';
    expect(parseTextToolCalls(json, known)).toEqual({ content: json, calls: [] });
    const prose = 'Settings:\nconfig\n{"path": "a"}';
    expect(parseTextToolCalls(prose, known)).toEqual({ content: prose, calls: [] });
  });

  test("ordinary code blocks and unknown names stay text", () => {
    const shell = "Run this:\n```bash\nnpm test\n```";
    expect(parseTextToolCalls(shell, known)).toEqual({ content: shell, calls: [] });
    const other = 'Config:\n```json\n{"name": "my-app", "version": "1.0.0"}\n```';
    expect(parseTextToolCalls(other, known)).toEqual({ content: other, calls: [] });
  });
});
