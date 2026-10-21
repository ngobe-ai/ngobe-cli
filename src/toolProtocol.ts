import type { Message, Tool } from "./types.js";

/**
 * Tool calling for endpoints or models without native support: the tools are described in
 * the system prompt and the model writes <tool_call> blocks, which are parsed and then
 * validated exactly like native calls. Nothing here executes anything.
 */

export function textProtocolPrompt(tools: Tool[]): string {
  const specs = tools
    .map((t) => `- ${t.name}: ${t.description}\n  arguments (JSON Schema): ${JSON.stringify(t.parameters)}`)
    .join("\n");
  return `# Tools
To call a tool, write a block like this (one block per call; several blocks are allowed):
<tool_call>
{"name": "read_file", "arguments": {"path": "src/index.ts"}}
</tool_call>
Then stop and wait: results come back in <tool_result> blocks. Use only these tools and argument names:
${specs}`;
}

export interface TextToolCall {
  name: string;
  /** Raw JSON string, validated by the agent like a native call. */
  arguments: string;
}

// <tool_request> is what some Qwen replies write instead of <tool_call>.
const BLOCK = /<(?:tool_call|tool_request)>([\s\S]*?)(?:<\/(?:tool_call|tool_request)>|$)/g;

/**
 * Extract tool calls written as text: the JSON form used by Hermes/Qwen 2.5 templates
 * (<tool_call>{"name": …, "arguments": {…}}</tool_call>) and the Qwen3-Coder XML form
 * (<tool_call><function=name><parameter=key>value</parameter></function></tool_call>).
 * A block that can't be parsed still becomes a call with its raw text as arguments, so
 * the model is told it was malformed instead of the call vanishing.
 *
 * Given the names of the tools on offer, looser shapes are accepted too (see parseLoose).
 */
export function parseTextToolCalls(text: string, known?: string[]): { content: string; calls: TextToolCall[] } {
  const calls: TextToolCall[] = [];
  for (const m of text.matchAll(BLOCK)) {
    const body = m[1].trim();
    if (body) calls.push(parseBlock(body));
  }
  if (calls.length || !known?.length) return { content: text.replace(BLOCK, "").trim(), calls };
  return parseLoose(text, known);
}

// Where models without a proper tool template (e.g. Qwen2.5-Coder) put a JSON call: a tag, a code
// fence of any language (it has used ```bash), or a line of its own.
const OPENERS = /<function>|<tools?>|```[\w-]*[ \t]*\r?\n?|(?:^|\n)[ \t]*(?=\{)/g;
// A fence language or a line of its own just above a JSON object (matched against the text before it).
const LABEL = /(?:```[ \t]*\r?\n?|(?:^|\n))[ \t]*([\w-]+)[ \t]*\r?\n[ \t]*$/;

/**
 * JSON tool calls wrapped in <function>, <tools>, a fenced code block, or making up the whole
 * reply. Accepted only when the name is a tool on offer; the agent still validates the
 * arguments and checks permissions, exactly as for native calls.
 */
function parseLoose(text: string, known: string[]): { content: string; calls: TextToolCall[] } {
  const calls: TextToolCall[] = [];
  let first = -1;
  const consider = (brace: number, start: number) => {
    const json = balancedObject(text, brace);
    if (!json) return;
    let call = asCall(json, known);
    // Or just the arguments, under the tool's name: ```bash\n{"command": …} or read_file\n{"path": …}
    const label = call ? null : LABEL.exec(text.slice(0, brace));
    if (label && known.includes(label[1])) {
      call = asArguments(json, label[1]);
      start = label.index;
    }
    if (!call) return;
    calls.push(call);
    if (first < 0) first = start;
  };
  const seen = new Set<number>();
  for (const m of text.matchAll(OPENERS)) {
    const after = m.index + m[0].length;
    const brace = text.indexOf("{", after);
    if (brace < 0 || seen.has(brace) || text.slice(after, brace).trim() !== "") continue;
    seen.add(brace); // a fenced call is found from both the fence and its own line
    consider(brace, m.index);
  }
  // Whatever follows the first call (often made-up results) is not part of the reply, nor is a
  // wrapper tag left open right before it.
  if (calls.length) return { content: text.slice(0, first).replace(/<\/?(?:tool_request|tool_call|tools?|function)>\s*$/, "").trim(), calls };
  const handoff = known.includes("bash") ? shellHandoff(text) : null;
  if (handoff) return { content: handoff.before, calls: [{ name: "bash", arguments: JSON.stringify({ command: handoff.command }) }] };
  const said = known.includes("bash") ? proseCommand(text, known) : null;
  if (said) return { content: text, calls: [{ name: "bash", arguments: JSON.stringify({ command: said }) }] };
  return { content: text, calls: [] };
}

const RUN_INTENT = /\b(?:i(?:'ll| will|'m going to| am going to)|let(?:'s| me))\s+(?:now\s+|first\s+|then\s+)?(?:use|run|execute|call)\b/i;
const SHELL_WORDS = /\b(?:bash|shell|terminal|command)\b|\b(?:run|execute)\s+`/i;

/**
 * "To confirm the version, I'll use the bash tool to run the `flutter --version` command." and the
 * reply ends: the command the model says it will run, if one sentence says so with exactly one
 * command in backticks. Suggestions to the user ("you can run …"), past tense ("I ran …") and
 * sentences about another tool are left alone; the call still goes through the permission check.
 */
export function proseCommand(text: string, known: string[]): string | null {
  for (const sentence of text.split(/(?<=[.!:])\s+/)) {
    if (!RUN_INTENT.test(sentence) || !SHELL_WORDS.test(sentence)) continue;
    if (known.some((t) => t !== "bash" && new RegExp(String.raw`\b${t}\b`).test(sentence))) continue;
    const spans = [...sentence.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).filter((s) => !known.includes(s));
    if (spans.length === 1 && /^[\w./~-]/.test(spans[0]) && spans[0].length <= 200) return spans[0];
  }
  return null;
}

const SHELL_FENCE = /```(?:bash|sh|shell|zsh|console|terminal)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/;
const ASKS_TO_RUN =
  /\b(?:provide|share|paste|send|show|give)\b[^.\n]{0,40}\b(?:output|results?|errors?)\b|\blet me know\b[^.\n]{0,40}\b(?:output|results?|errors?|happens)\b|\bonce you(?:'ve| have) run\b|\b(?:run|execute) (?:this|these|it|the (?:following|command|tests?))\b[^.\n]{0,40}\b(?:and|then) (?:share|send|paste|provide|tell)\b/i;

/**
 * Small models also hand commands to the user ("run this and paste the output") instead of
 * calling bash. When a reply puts a short command in a shell block and asks the user to run it
 * or share its output, it becomes a bash call, with the usual permission check. Plain
 * instructions ("to start the server, run …") are left alone.
 */
export function shellHandoff(text: string): { command: string; before: string } | null {
  const m = SHELL_FENCE.exec(text);
  if (!m || !ASKS_TO_RUN.test(text)) return null;
  const lines = m[1]
    .split("\n")
    .map((l) => l.trim().replace(/^\$\s+/, ""))
    .filter((l) => l && !l.startsWith("#"));
  if (!lines.length || lines.length > 3) return null;
  return { command: lines.join(" && "), before: text.slice(0, m.index).trim() };
}

// "I'll create …", "Let's start by …", "First, …": the model saying it will do the work itself.
const OWN_PLAN = /\b(?:i(?:'ll| will|'m going to| am going to)|let(?:'s| me| us)|first,|step 1\b)/i;
// Commands that never exit: started by the user, or with bash run_in_background.
const SERVER = /^(?:(?:npm|pnpm|yarn|bun) (?:run )?(?:dev|start|serve|preview)|npx (?:next|vite|expo) (?:dev|start)|next dev|vite$|flutter run|php artisan serve|(?:uv run |python3? )?manage\.py runserver|rails s(?:erver)?|go run|cargo run|deno task dev|fastapi dev)\b/;

/**
 * Small models asked to build something often write it as steps for the user ("First, I'll create
 * a new Next.js project: ```bash npx create-next-app …```") and stop. When the reply says the
 * model will do it and has a shell block of a few commands, the first block is run with bash
 * (servers that never exit left out); the caller only does this for requests to change or build
 * something. Instructions on their own ("To start the server, run …") are left alone.
 */
export function planHandoff(text: string): { command: string; before: string } | null {
  const fence = new RegExp(SHELL_FENCE.source, "g");
  for (const m of text.matchAll(fence)) {
    if (!OWN_PLAN.test(text.slice(0, m.index))) return null;
    const lines = m[1]
      .split("\n")
      .map((l) => l.trim().replace(/^\$\s+/, ""))
      .filter((l) => l && !l.startsWith("#"));
    if (!lines.length || lines.length > 6) return null;
    const steps = lines.filter((l) => !SERVER.test(l));
    if (!steps.length) return null;
    return { command: steps.join(" && "), before: text.slice(0, m.index).trim() };
  }
  return null;
}

// Fence languages that can hold a file with this extension.
const FENCE_LANGS: Record<string, string[]> = {
  html: ["html", "htm"], htm: ["html", "htm"], css: ["css"], scss: ["scss", "css"], js: ["js", "javascript"], mjs: ["js", "javascript"],
  jsx: ["jsx", "javascript", "js"], ts: ["ts", "typescript"], tsx: ["tsx", "typescript", "ts"], vue: ["vue", "html"], svelte: ["svelte", "html"],
  py: ["py", "python"], dart: ["dart"], go: ["go"], rs: ["rs", "rust"], java: ["java"], kt: ["kt", "kotlin"], swift: ["swift"], rb: ["rb", "ruby"],
  php: ["php"], json: ["json"], yaml: ["yaml", "yml"], yml: ["yaml", "yml"], md: ["md", "markdown"], sql: ["sql"], sh: ["sh", "bash", "shell", "zsh"],
  c: ["c"], cpp: ["cpp", "c++"], cs: ["cs", "csharp"], xml: ["xml"], svg: ["svg", "xml"], toml: ["toml"],
};
const FILE_NAME = /(?<![\w/.-])((?:[\w@+-]+\/)*[\w@+-][\w.@+-]*\.([A-Za-z0-9]{1,6}))(?![\w-])/g;
// Names of technologies, not files: "a new Next.js project" (seen live, saved as a file named Next.js).
const TECH_NAME = /^(?:next|node|nuxt|vue|react|express|nest|three|chart|d3|ember|backbone|alpine|angular|moment|day|anime|video|socket\.io|p5|pixi|babylon|leaflet|deno|bun|electron|meteor|gatsby|preact|solid|svelte|koa|hapi|sails|knockout|handlebars|underscore|lodash|jquery|ext|mocha|chai|immutable|redux|zod|vite)\.js$/i;

/**
 * A small model asked to create a file often writes it in its reply ("Here's the complete file:
 * ```html …```") and stops. When the request (or else the reply) names a file that doesn't exist
 * yet and the reply has exactly one complete code block for that kind of file, it becomes a
 * write_file call, with the usual permission check. Existing files are left to edit_file.
 */
export function fileHandoff(reply: string, request: string, exists: (p: string) => boolean): { path: string; content: string; before: string } | null {
  const blocks = [...reply.matchAll(/```([\w+-]*)[ \t]*\r?\n([\s\S]*?)\r?\n```/g)];
  if (!blocks.length) return null;
  const names = (text: string) =>
    [...text.matchAll(FILE_NAME)].map((m) => ({ path: m[1], ext: m[2].toLowerCase() })).filter((n) => FENCE_LANGS[n.ext] && !TECH_NAME.test(n.path) && !exists(n.path));
  for (const candidates of [names(request), names(reply)]) {
    for (const file of candidates) {
      const langs = FENCE_LANGS[file.ext];
      const fits = blocks.filter((b) => langs.includes(b[1].toLowerCase()) || (!b[1] && blocks.length === 1));
      if (fits.length !== 1 || fits[0][2].split("\n").length < 3) continue;
      return { path: file.path, content: `${fits[0][2]}\n`, before: reply.slice(0, fits[0].index).trim() };
    }
  }
  return null;
}

/** The JSON object starting at text[start] (a "{"), matching braces outside strings. */
function balancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function asCall(json: string, known: string[]): TextToolCall | null {
  try {
    const p = JSON.parse(json) as { name?: unknown; arguments?: unknown; parameters?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = p.name ?? p.function?.name;
    if (typeof name !== "string" || !known.includes(name)) return null;
    const args = p.arguments ?? p.parameters ?? p.function?.arguments ?? {};
    return { name, arguments: typeof args === "string" ? args : JSON.stringify(args) };
  } catch {
    return null;
  }
}

/** A bare JSON object taken as the arguments of `name`; one shaped like a call is not. */
function asArguments(json: string, name: string): TextToolCall | null {
  try {
    const p = JSON.parse(json) as unknown;
    if (!p || typeof p !== "object" || Array.isArray(p) || "name" in p || "function" in p || "arguments" in p) return null;
    return { name, arguments: JSON.stringify(p) };
  } catch {
    return null;
  }
}

function parseBlock(body: string): TextToolCall {
  const fn = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/.exec(body);
  if (fn) {
    const args: Record<string, string> = {};
    for (const p of fn[2].matchAll(/<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) args[p[1]] = p[2];
    return { name: fn[1], arguments: JSON.stringify(args) };
  }
  try {
    const parsed = JSON.parse(body) as { name?: unknown; arguments?: unknown; parameters?: unknown };
    const args = parsed.arguments ?? parsed.parameters ?? {};
    return { name: String(parsed.name ?? ""), arguments: typeof args === "string" ? args : JSON.stringify(args) };
  } catch {
    return { name: /"name"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? "", arguments: body };
  }
}

/** Rewrite native tool-call history as plain text, merging consecutive messages of the same role. */
export function toTextMessages(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    let next: Message = m;
    if (m.role === "assistant" && m.tool_calls?.length) {
      const blocks = m.tool_calls.flatMap((c) =>
        c.type === "function"
          ? [`<tool_call>\n{"name": ${JSON.stringify(c.function.name)}, "arguments": ${c.function.arguments || "{}"}}\n</tool_call>`]
          : [],
      );
      next = { role: "assistant", content: [typeof m.content === "string" ? m.content : "", ...blocks].filter(Boolean).join("\n") };
    } else if (m.role === "tool") {
      next = { role: "user", content: `<tool_result>\n${typeof m.content === "string" ? m.content : ""}\n</tool_result>` };
    }
    const prev = out[out.length - 1];
    if (prev && prev.role === next.role && (next.role === "user" || next.role === "assistant") && typeof prev.content === "string" && typeof next.content === "string") {
      out[out.length - 1] = { ...prev, content: `${prev.content}\n\n${next.content}` } as Message;
    } else {
      out.push(next);
    }
  }
  return out;
}

const TAGS = ["<tool_call", "<tool_request", "<function"];

/**
 * How much of streamed text is safe to show: everything before a <tool_call> or <function>
 * block, holding back a trailing fragment that might be the start of one ("<to…").
 * With holdJson (models that write calls as plain JSON), also everything from a code fence or a
 * line starting with "{", and a last one-word line that may be a tool's name above its arguments:
 * the caller shows it at the end of the turn if it wasn't a call.
 */
export function visibleLength(content: string, final: boolean, holdJson = false): number {
  const cuts = TAGS.map((t) => content.indexOf(t)).filter((i) => i >= 0);
  if (holdJson && !final) {
    const fence = content.indexOf("```");
    const brace = /(^|\n)[ \t]*\{/.exec(content);
    const label = /(^|\n)[ \t]*[\w-]+[ \t]*(?:\r?\n[ \t]*(?:\{[\s\S]*)?)?$/.exec(content);
    if (fence >= 0) cuts.push(fence);
    if (brace) cuts.push(brace.index + (brace[1] ? 1 : 0));
    if (label) cuts.push(label.index + (label[1] ? 1 : 0));
  }
  if (cuts.length) return Math.min(...cuts);
  if (final) return content.length;
  for (let k = Math.min(Math.max(...TAGS.map((t) => t.length)) - 1, content.length); k > 0; k--) {
    const tail = content.slice(-k);
    if (TAGS.some((t) => t.startsWith(tail))) return content.length - k;
  }
  return content.length;
}
