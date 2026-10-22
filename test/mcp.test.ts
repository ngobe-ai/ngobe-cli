import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { headerParams, headerValue, McpClient } from "../src/mcp/client.js";
import { expandVars, loadServers, redactServer, toMs, toSpec, type McpServerSpec } from "../src/mcp/config.js";
import { McpManager } from "../src/mcp/index.js";
import { firstSentence, mcpNeed, mcpToolName, modelSchema, resultText, toTool } from "../src/mcp/tools.js";
import { createSession } from "../src/session.js";
import { trustFolder } from "../src/trust.js";
import type { ToolImage } from "../src/types.js";
import { handler, TOOLS } from "./fixtures/mcpServer.js";
import { fakeModel, recordingUi, testConfig, tmpDir } from "./helpers.js";

const FIXTURE = path.join(import.meta.dir, "fixtures", "mcpServer.ts");
const defaults = { cwd: process.cwd(), connectTimeoutMs: 10_000, toolTimeoutMs: 5_000, env: {} };

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function stdioSpec(mode: string, extra: Record<string, unknown> = {}): McpServerSpec {
  return toSpec("fx", { command: process.execPath, args: [FIXTURE, mode], ...extra }, "user", "test", defaults);
}

async function connected(spec: McpServerSpec, probeMs?: number): Promise<McpClient> {
  const client = new McpClient(spec, { probeMs });
  cleanups.push(() => client.close());
  await client.connect();
  return client;
}

describe("config", () => {
  test("${VAR} and ${VAR:-default} expand; unset ones are reported", () => {
    const missing = new Set<string>();
    expect(expandVars("Bearer ${TOKEN} ${HOST:-localhost} ${NOPE}", { TOKEN: "abc" }, missing)).toBe("Bearer abc localhost ");
    expect([...missing]).toEqual(["NOPE"]);
  });

  test("entries in Claude Code's format become specs", () => {
    expect(toSpec("fs", { command: "npx", args: ["-y", "x"] }, "user", "f", defaults).transport).toBe("stdio");
    expect(toSpec("docs", { url: "https://e.com/mcp" }, "user", "f", defaults).transport).toBe("http");
    expect(toSpec("docs", { type: "streamable-http", url: "https://e.com/mcp" }, "user", "f", defaults).transport).toBe("http");
    expect(toSpec("old", { type: "sse", url: "https://e.com/sse" }, "user", "f", defaults).transport).toBe("sse");
    expect(toSpec("bad name", { command: "x" }, "user", "f", defaults).error).toContain("letters, digits");
    expect(toSpec("x", { type: "http" }, "user", "f", defaults).error).toContain("url");
    expect(toSpec("x", {}, "user", "f", defaults).error).toContain("command");
    expect(toSpec("x", { type: "ws", url: "ws://e" }, "user", "f", defaults).error).toContain("unknown type");
    const spec = toSpec("gh", { command: "gh-mcp", env: { TOKEN: "${GH_PAT}" } }, "user", "f", defaults);
    expect(spec.error).toBe("environment variable GH_PAT not set");
    const ok = toSpec("gh", { command: "gh-mcp", env: { TOKEN: "${GH_PAT}" }, autoApprove: ["search"], tools: ["search", "get"] }, "user", "f", { ...defaults, env: { GH_PAT: "p" } });
    expect(ok.env).toEqual({ TOKEN: "p" });
    expect(ok.autoApprove.has("search")).toBe(true);
    expect([...(ok.allow ?? [])]).toEqual(["search", "get"]);
  });

  test("timeouts are seconds, or milliseconds above 1000 (Claude Code's MCP_TIMEOUT)", () => {
    expect(toMs(45, 1)).toBe(45_000);
    expect(toMs(60_000, 1)).toBe(60_000);
    expect(toMs(undefined, 7)).toBe(7);
    expect(toMs("nope", 7)).toBe(7);
  });

  test("a project's .mcp.json counts only in a trusted folder, and overrides the user's server", () => {
    const cwd = tmpDir();
    fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { fs: { command: "proj-fs" }, extra: { command: "e" } } }));
    const user = { fs: { command: "user-fs" }, mine: { command: "m" } };
    const opts = { user, userFile: "u.json", cwd, defaults: { connectTimeoutMs: 1, toolTimeoutMs: 1, env: {} } };
    const untrusted = loadServers({ ...opts, trusted: false });
    expect(untrusted.specs.map((s) => `${s.name}:${s.command}`)).toEqual(["fs:user-fs", "mine:m"]);
    expect(untrusted.untrusted).toEqual(["fs", "extra"]);
    const trusted = loadServers({ ...opts, trusted: true });
    expect(trusted.specs.map((s) => `${s.name}:${s.command}:${s.scope}`)).toEqual(["extra:e:project", "fs:proj-fs:project", "mine:m:user"]);
    fs.writeFileSync(path.join(cwd, ".mcp.json"), "{nope");
    expect(loadServers({ ...opts, trusted: true }).warnings[0]).toContain("not valid JSON");
  });

  test("display hides env values and credential headers, keeps ${VAR} references", () => {
    const shown = redactServer({ command: "x", env: { TOKEN: "secret" }, headers: { Authorization: "Bearer abc", "X-Api-Key": "${KEY}", Accept: "json" }, url: "https://e.com/mcp?api_key=zzz" }) as Record<string, any>;
    expect(shown.env).toEqual({ TOKEN: "[hidden]" });
    expect(shown.headers).toEqual({ Authorization: "[redacted]", "X-Api-Key": "${KEY}", Accept: "json" });
    expect(shown.url).toBe("https://e.com/mcp?api_key=[redacted]");
  });
});

describe("tools", () => {
  test("names are mcp__server__tool, safe for function calling, at most 64 characters", () => {
    expect(mcpToolName("fs", "read_file")).toBe("mcp__fs__read_file");
    expect(mcpToolName("my.server", "admin.tools.list")).toBe("mcp__my_server__admin_tools_list");
    const long = mcpToolName("server", "x".repeat(100));
    expect(long.length).toBe(64);
    expect(long).not.toBe(mcpToolName("server", "x".repeat(99)));
  });

  test("the model's schema drops noise; lean descriptions are one sentence", () => {
    const schema = { $schema: "s", type: "object", properties: { title: { type: "string", description: "The page title. Shown in tabs." }, region: { type: "string", "x-mcp-header": "Region" } }, required: ["title"] };
    expect(modelSchema(schema, true)).toEqual({ type: "object", properties: { title: { type: "string", description: "The page title." }, region: { type: "string" } }, required: ["title"] });
    expect(modelSchema(undefined, false)).toEqual({ type: "object", properties: {} });
    expect(firstSentence("Navigate to a URL. Waits for load.", 200)).toBe("Navigate to a URL.");
    expect(firstSentence("x".repeat(300), 10)).toBe(`${"x".repeat(9)}…`);
  });

  test("approval: read-only and auto-approved tools run, destructive ones ask every time", () => {
    const spec = { autoApprove: new Set(["add"]) };
    expect(mcpNeed({ name: "echo", annotations: { readOnlyHint: true } }, spec)).toBe("none");
    expect(mcpNeed({ name: "add" }, spec)).toBe("none");
    expect(mcpNeed({ name: "write" }, spec)).toBe("approval");
    expect(mcpNeed({ name: "crash", annotations: { destructiveHint: true } }, spec)).toBe("explicit");
    expect(mcpNeed({ name: "crash", annotations: { destructiveHint: true } }, { autoApprove: new Set(["*"]) })).toBe("none");
  });

  test("results become text: media and links as placeholders, structured content as JSON", () => {
    expect(resultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
    expect(resultText({ content: [{ type: "image", data: Buffer.alloc(3000).toString("base64"), mimeType: "image/png" }] })).toBe("[image: image/png, 3 KB; not shown to the model]");
    expect(resultText({ content: [{ type: "image", data: Buffer.alloc(3000).toString("base64"), mimeType: "image/png" }] }, true)).toBe("[image: image/png, 3 KB; shown to you after the tool results]");
    expect(resultText({ content: [{ type: "resource_link", uri: "file:///a", name: "a" }] })).toBe("[resource: a <file:///a>]");
    expect(resultText({ content: [{ type: "resource", resource: { uri: "file:///b", text: "hi" } }] })).toBe("[resource file:///b]\nhi");
    expect(resultText({ content: [], structuredContent: { ok: 1 } })).toBe('{\n  "ok": 1\n}');
    expect(resultText({ content: [{ type: "text", text: "[1,2]" }], structuredContent: [1, 2] })).toBe("[1,2]");
  });

  test("x-mcp-header: only plain primitive properties, unique names; values encoded", () => {
    expect(headerParams({ type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } }).params).toEqual([{ path: ["region"], header: "Region" }]);
    expect(headerParams({ type: "object", properties: { n: { type: "number", "x-mcp-header": "N" } } }).error).toContain("string, integer or boolean");
    expect(headerParams({ type: "object", properties: { a: { type: "array", items: { type: "string", "x-mcp-header": "A" } } } }).error).toContain("outside plain properties");
    expect(headerParams({ type: "object", properties: { a: { type: "string", "x-mcp-header": "X" }, b: { type: "string", "x-mcp-header": "x" } } }).error).toContain("twice");
    expect(headerValue("us-west1")).toBe("us-west1");
    expect(headerValue("Hello, 世界")).toBe("=?base64?SGVsbG8sIOS4lueVjA==?=");
    expect(headerValue(" padded ")).toBe("=?base64?IHBhZGRlZCA=?=");
    expect(headerValue("=?base64?literal?=")).toBe("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=");
  });
});

describe("stdio", () => {
  test("a modern server: server/discover, _meta on every request, paged tool list, calls", async () => {
    const client = await connected(stdioSpec("modern"));
    expect(client.era).toBe("modern");
    expect(client.version).toBe("2026-07-28");
    expect(client.serverInfo?.name).toBe("fixture");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const echo = toTool(client, tools.find((t) => t.name === "echo")!, true);
    expect(echo.name).toBe("mcp__fx__echo");
    expect(echo.description).toBe("Echo the text back.");
    expect(echo.risk).toBe("network");
    expect(echo.parameters).toEqual({ type: "object", properties: { text: { type: "string", description: "What to echo." } }, required: ["text"] });
    expect(await echo.run({ text: "hi" }, { cwd: "." })).toBe("echo: hi");
    const fail = toTool(client, tools.find((t) => t.name === "fail")!, true);
    expect(fail.risk).toBe("write");
    await expect(fail.run({}, { cwd: "." })).rejects.toThrow("it broke");
    const structured = toTool(client, tools.find((t) => t.name === "structured")!, false);
    expect(await structured.run({}, { cwd: "." })).toContain('"items"');
  });

  test("a tool's image (a browser screenshot) is shown to a model that sees images", async () => {
    const client = await connected(stdioSpec("modern"));
    const { tools } = await client.listTools();
    const image = toTool(client, tools.find((t) => t.name === "image")!, true);
    expect(await image.run({}, { cwd: "." })).toContain("not shown to the model");
    const attached: ToolImage[] = [];
    expect(await image.run({}, { cwd: ".", attach: (i) => attached.push(i) })).toContain("shown to you after the tool results");
    expect(attached).toEqual([{ mime: "image/png", data: Buffer.alloc(3000).toString("base64") }]);
  });

  test("the server gets its configured env, but not ngobe's credentials", async () => {
    const saved = process.env.NGOBE_API_KEY;
    process.env.NGOBE_API_KEY = "ngobe-secret";
    try {
      const client = await connected(toSpec("fx", { command: process.execPath, args: [FIXTURE, "modern"], env: { FIXTURE_TOKEN: "${MY_TOKEN}" } }, "user", "t", { ...defaults, env: { MY_TOKEN: "for-the-server" } }));
      expect(JSON.parse((await client.callTool("env", {}, AbortSignal.timeout(5000))).content![0].text!)).toEqual({ apiKey: null, token: "for-the-server" });
    } finally {
      if (saved === undefined) delete process.env.NGOBE_API_KEY;
      else process.env.NGOBE_API_KEY = saved;
    }
  });

  test("a 2025-era server: initialize handshake after the probe fails", async () => {
    const client = await connected(stdioSpec("legacy"));
    expect(client.era).toBe("legacy");
    expect(client.version).toBe("2025-06-18");
    expect((await client.callTool("add", { a: 2, b: 3 }, AbortSignal.timeout(5000))).content?.[0].text).toBe("5");
  });

  test("a legacy server that ignores the probe is initialized after a short wait", async () => {
    const client = await connected(stdioSpec("silent"), 300);
    expect(client.era).toBe("legacy");
    expect((await client.listTools()).tools).toHaveLength(TOOLS.length);
  });

  test("a modern server that only speaks 2025-11-25 says so, and gets initialize with it", async () => {
    const client = await connected(stdioSpec("old-only"));
    expect(client.era).toBe("legacy");
    expect(client.version).toBe("2025-11-25");
  });

  test("pings from a 2025-era server are answered", async () => {
    const client = await connected(stdioSpec("pinger"));
    await Bun.sleep(100);
    expect((await client.callTool("pinged", {}, AbortSignal.timeout(5000))).content?.[0].text).toBe("yes");
  });

  test("a call that takes too long is cancelled; the server keeps working", async () => {
    const client = await connected(stdioSpec("modern"));
    await expect(client.callTool("slow", { ms: 3000 }, AbortSignal.timeout(200))).rejects.toThrow();
    expect((await client.callTool("echo", { text: "still here" }, AbortSignal.timeout(5000))).content?.[0].text).toBe("echo: still here");
  });

  test("a server that dies mid-session reports why, and is restarted for the next call", async () => {
    const client = await connected(stdioSpec("modern"));
    await expect(client.callTool("crash", {}, AbortSignal.timeout(5000))).rejects.toThrow(/exited \(code 3\).*crashing on purpose/s);
    expect((await client.callTool("echo", { text: "back" }, AbortSignal.timeout(10_000))).content?.[0].text).toBe("echo: back");
  });

  test("a command that doesn't exist fails clearly", async () => {
    const client = new McpClient(toSpec("nope", { command: "ngobe-no-such-mcp-server" }, "user", "t", defaults));
    await expect(client.connect()).rejects.toThrow(/could not start ngobe-no-such-mcp-server/);
  });

  test("a server that never answers fails after the startup limit", async () => {
    const spec = toSpec("hang", { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], timeout: 1 }, "user", "t", defaults);
    const client = new McpClient(spec, { probeMs: 100 });
    cleanups.push(() => client.close());
    await expect(client.connect()).rejects.toThrow("no answer within 1s");
  });
});

/** An HTTP MCP server around the fixture handler: modern, 2025-era with sessions, or 2024-11-05 HTTP+SSE. */
function httpServer(mode: "modern" | "legacy" | "sse" | "auth") {
  const seen: { method: string; headers: Record<string, string>; body?: any }[] = [];
  const sessions = new Set<string>();
  let expireNext = false;
  const handle = handler(mode === "modern" ? "modern" : "legacy", () => {}, () => {});
  let sseWrite: ((m: unknown) => void) | null = null;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const headers = Object.fromEntries(req.headers.entries());
      if (mode === "auth") return new Response("unauthorized", { status: 401 });
      if (mode === "sse") {
        if (req.method === "GET" && url.pathname === "/sse") {
          const stream = new ReadableStream({
            start(c) {
              const enc = new TextEncoder();
              sseWrite = (m) => c.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(m)}\n\n`));
              c.enqueue(enc.encode(`event: endpoint\ndata: /messages?sessionId=1\n\n`));
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        if (req.method === "POST" && url.pathname === "/messages") {
          const body = await req.json();
          seen.push({ method: body.method, headers, body });
          const r = await handle(body);
          if (r) setTimeout(() => sseWrite?.(r), 5);
          return new Response("Accepted", { status: 202 });
        }
        return new Response("Method Not Allowed", { status: 405 });
      }
      if (req.method === "DELETE") {
        seen.push({ method: "DELETE", headers });
        return new Response(null, { status: 200 });
      }
      const body = await req.json();
      seen.push({ method: body.method, headers, body });
      if (mode === "legacy" && body.method !== "initialize") {
        const sid = headers["mcp-session-id"];
        if (!sid) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: Server not initialized" } }, { status: 400 });
        if (!sessions.has(sid) || expireNext) {
          expireNext = false;
          sessions.delete(sid);
          return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } }, { status: 404 });
        }
      }
      const r = await handle(body);
      if (!r) return new Response(null, { status: 202 });
      const extra: Record<string, string> = {};
      if (mode === "legacy" && body.method === "initialize") {
        const sid = crypto.randomUUID();
        sessions.add(sid);
        extra["mcp-session-id"] = sid;
      }
      if (body.method === "tools/call") {
        // Calls answer with an event stream: a progress notification, then the response.
        const progress = { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } };
        return new Response(`: keep-alive\n\nevent: message\ndata: ${JSON.stringify(progress)}\n\ndata: ${JSON.stringify(r)}\n\n`, { headers: { "content-type": "text/event-stream", ...extra } });
      }
      return Response.json(r, { headers: extra });
    },
  });
  cleanups.push(() => server.stop(true));
  const base = `http://localhost:${server.port}`;
  return { url: mode === "sse" ? `${base}/sse` : `${base}/mcp`, seen, expire: () => (expireNext = true) };
}

describe("HTTP", () => {
  test("modern Streamable HTTP: headers mirror the body, calls answered over SSE", async () => {
    const s = httpServer("modern");
    const client = await connected(toSpec("web", { url: s.url, headers: { "X-Client": "t" } }, "user", "t", defaults));
    expect(client.era).toBe("modern");
    await client.listTools();
    expect((await client.callTool("echo", { text: "über" }, AbortSignal.timeout(5000))).content?.[0].text).toBe("echo: über");
    const call = s.seen.find((r) => r.method === "tools/call")!;
    expect(call.headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(call.headers["mcp-method"]).toBe("tools/call");
    expect(call.headers["mcp-name"]).toBe("echo");
    expect(call.headers["x-client"]).toBe("t");
    expect(call.headers.accept).toBe("application/json, text/event-stream");
    expect(call.body.params._meta["io.modelcontextprotocol/clientInfo"].name).toBe("ngobe");
    expect(s.seen.some((r) => r.method === "initialize")).toBe(false);
  });

  test("a 2025-era Streamable HTTP server: initialize, session id on every request, new session when it expires, DELETE at the end", async () => {
    const s = httpServer("legacy");
    const client = await connected(toSpec("web", { url: s.url }, "user", "t", defaults));
    expect(client.era).toBe("legacy");
    expect((await client.listTools()).tools).toHaveLength(TOOLS.length);
    const list = s.seen.find((r) => r.method === "tools/list")!;
    expect(list.headers["mcp-session-id"]).toBeTruthy();
    expect(list.headers["mcp-protocol-version"]).toBe("2025-06-18");
    s.expire();
    expect((await client.callTool("echo", { text: "again" }, AbortSignal.timeout(5000))).content?.[0].text).toBe("echo: again");
    expect(s.seen.filter((r) => r.method === "initialize")).toHaveLength(2);
    await client.close();
    expect(s.seen.at(-1)?.method).toBe("DELETE");
  });

  test("the deprecated HTTP+SSE transport, found by falling back from POST", async () => {
    const s = httpServer("sse");
    const client = await connected(toSpec("old", { url: s.url }, "user", "t", defaults));
    expect(client.era).toBe("legacy");
    expect((await client.callTool("add", { a: 1, b: 1 }, AbortSignal.timeout(5000))).content?.[0].text).toBe("2");
  });

  test("a 401 says the server needs a token in headers", async () => {
    const s = httpServer("auth");
    const client = new McpClient(toSpec("web", { url: s.url }, "user", "t", defaults));
    await expect(client.connect()).rejects.toThrow(/HTTP 401.*headers/);
  });
});

describe("session", () => {
  test("servers start with the session; tools are sorted, failures are warnings; untrusted .mcp.json is skipped", async () => {
    const cwd = tmpDir();
    fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { command: process.execPath, args: [FIXTURE, "modern"] } } }));
    const config = testConfig({
      cwd,
      mcpServers: { fx: { command: process.execPath, args: [FIXTURE, "legacy"], tools: ["echo", "add"] }, broken: { command: "ngobe-no-such-mcp-server" } },
    });
    const warnings: string[] = [];
    const mcp = await McpManager.start(config, { trusted: false, warn: (t) => warnings.push(t) });
    cleanups.push(() => mcp.close());
    expect(mcp.tools.map((t) => t.name)).toEqual(["mcp__fx__add", "mcp__fx__echo"]);
    expect(mcp.servers.map((s) => `${s.name}:${s.state}`)).toEqual(["broken:failed", "fx:connected"]);
    expect(warnings.join("\n")).toContain("MCP server broken failed");
    expect(warnings.join("\n")).toContain("Not starting the MCP servers in .mcp.json (proj)");
    const trusted = await McpManager.start(config, { trusted: true });
    cleanups.push(() => trusted.close());
    expect(trusted.tools.map((t) => t.name)).toContain("mcp__proj__echo");
  });

  test("end to end: the model calls an MCP tool and gets its result; one that changes things asks first", async () => {
    const model = fakeModel([
      { toolCalls: [{ name: "mcp__fx__echo", arguments: JSON.stringify({ text: "from the model" }) }] },
      { toolCalls: [{ name: "mcp__fx__add", arguments: JSON.stringify({ a: 20, b: 22 }) }] },
      { content: "The server said 42." },
    ]);
    cleanups.push(model.stop);
    const cwd = tmpDir();
    const config = testConfig({ baseURL: model.baseURL, model: "fake-model", maxRetries: 0, cwd, toolMode: "native", mcpServers: { fx: { command: process.execPath, args: [FIXTURE, "modern"] } } });
    trustFolder(cwd, config.stateDir);
    const { ui, log } = recordingUi("y");
    const session = await createSession(config, ui, { command: "prompt", memory: null });
    cleanups.push(() => session.mcp?.close());
    const result = await session.agent.run("use the fixture server", new AbortController().signal);
    expect(result.text).toBe("The server said 42.");
    const offered = (model.requests[0].tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(offered.slice(-TOOLS.length)).toEqual(TOOLS.map((t) => `mcp__fx__${t.name}`).sort());
    const messages = model.requests[2].messages as { role: string; content: string }[];
    const results = messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(results).toEqual(["echo: from the model", "42"]);
    // echo is read-only (no prompt); add asks.
    expect(log.prompts).toHaveLength(1);
    expect(log.prompts[0]).toContain("fx MCP tool add");
    expect(log.views.find((v) => v.state === "ok")?.label).toBe("fx - echo (MCP)");
  });
});
