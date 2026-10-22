/**
 * A scripted MCP server for the tests, in both protocol eras. `handler(mode)` answers one
 * JSON-RPC message (null = no answer); run as a script it serves that over stdio:
 *   bun test/fixtures/mcpServer.ts <modern|legacy|silent|old-only|pinger>
 * modern   : server/discover, per-request _meta required, no initialize
 * legacy   : 2025-06-18 initialize handshake; requests before it get -32601
 * silent   : legacy that ignores everything before initialize (the probe has to time out)
 * old-only : a modern server that only speaks 2025-11-25 (UnsupportedProtocolVersion, then initialize)
 * pinger   : legacy that pings the client after initialized; tool "pinged" says if it was answered
 */

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: any };

/** What the "image" tool returns: a PNG (a 10×10 header, padded to 3 KB), like a small screenshot. */
export const IMAGE_PNG = (() => {
  const b = Buffer.alloc(3000);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10, 8, 6]);
  return b.toString("base64");
})();

export const TOOLS = [
  { name: "echo", description: "Echo the text back. Second sentence.", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { text: { type: "string", description: "What to echo. Long details here." } }, required: ["text"] }, annotations: { readOnlyHint: true } },
  { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
  { name: "fail", description: "Always fails", inputSchema: { type: "object" } },
  { name: "slow", description: "Waits", inputSchema: { type: "object", properties: { ms: { type: "integer" } } } },
  { name: "crash", description: "Exits the server", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
  { name: "image", description: "Returns an image and a resource", inputSchema: { type: "object" } },
  { name: "structured", description: "Returns only structured content", inputSchema: { type: "object" } },
  { name: "pinged", description: "Whether the client answered the ping", inputSchema: { type: "object" } },
  { name: "env", description: "What the server's environment has", inputSchema: { type: "object" } },
];

export function handler(mode: string, send: (m: Msg) => void, exit: (code: number) => void) {
  let initialized = false;
  let pingAnswered = false;
  const legacy = mode !== "modern";
  return async (m: Msg): Promise<Msg | null> => {
    if (!m.method) {
      if (m.id === "ping-1" && m.result) pingAnswered = true;
      return null;
    }
    const reply = (result: any): Msg | null => (m.id === undefined ? null : { jsonrpc: "2.0", id: m.id, result });
    const error = (code: number, message: string, data?: any): Msg | null => (m.id === undefined ? null : { jsonrpc: "2.0", id: m.id, error: { code, message, ...(data ? { data } : {}) } });
    if (m.method === "notifications/initialized") {
      initialized = true;
      if (mode === "pinger") setTimeout(() => send({ jsonrpc: "2.0", id: "ping-1", method: "ping" }), 10);
      return null;
    }
    if (m.method === "notifications/cancelled") return null;
    if (m.method === "server/discover") {
      if (mode === "silent") return null;
      if (mode === "old-only") return error(-32022, "Unsupported protocol version", { supported: ["2025-11-25"], requested: m.params?._meta?.["io.modelcontextprotocol/protocolVersion"] });
      if (legacy) return error(-32601, "Method not found");
      return reply({ resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, ttlMs: 0, cacheScope: "public", _meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1.0.0" } } });
    }
    if (m.method === "initialize") {
      if (!legacy) return error(-32601, "initialize is not a method in 2026-07-28; supported versions: 2026-07-28");
      const asked = m.params?.protocolVersion;
      const version = mode === "old-only" ? "2025-11-25" : asked === "2025-11-25" || asked === "2025-06-18" ? "2025-06-18" : asked;
      return reply({ protocolVersion: version, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fixture", version: "1.0.0" } });
    }
    if (legacy && !initialized) return mode === "silent" ? null : error(-32601, "not initialized");
    if (!legacy) {
      const meta = m.params?._meta ?? {};
      if (meta["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28" || !meta["io.modelcontextprotocol/clientCapabilities"]) return error(-32602, "missing _meta");
    }
    if (m.method === "tools/list") {
      // Two pages, to test the cursor.
      const page = m.params?.cursor === "p2" ? 1 : 0;
      return reply({ tools: page === 0 ? TOOLS.slice(0, 3) : TOOLS.slice(3), ...(page === 0 ? { nextCursor: "p2" } : {}) });
    }
    if (m.method === "tools/call") {
      const args = m.params?.arguments ?? {};
      switch (m.params?.name) {
        case "echo":
          return reply({ content: [{ type: "text", text: `echo: ${args.text}` }] });
        case "add":
          return reply({ content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }], structuredContent: { sum: Number(args.a) + Number(args.b) } });
        case "fail":
          return reply({ content: [{ type: "text", text: "it broke" }], isError: true });
        case "slow":
          await new Promise((r) => setTimeout(r, Number(args.ms ?? 1000)));
          return reply({ content: [{ type: "text", text: "slept" }] });
        case "crash":
          process.stderr.write("fatal: crashing on purpose\n");
          exit(3);
          return null;
        case "image":
          return reply({
            content: [
              { type: "image", data: IMAGE_PNG, mimeType: "image/png" },
              { type: "resource_link", uri: "file:///x/a.txt", name: "a.txt", mimeType: "text/plain" },
              { type: "resource", resource: { uri: "file:///x/b.txt", text: "inside b" } },
            ],
          });
        case "structured":
          return reply({ content: [], structuredContent: { ok: true, items: [1, 2] } });
        case "pinged":
          return reply({ content: [{ type: "text", text: pingAnswered ? "yes" : "no" }] });
        case "env":
          return reply({ content: [{ type: "text", text: JSON.stringify({ apiKey: process.env.NGOBE_API_KEY ?? null, token: process.env.FIXTURE_TOKEN ?? null }) }] });
        default:
          return error(-32602, `Unknown tool: ${m.params?.name}`);
      }
    }
    return error(-32601, `Method not found: ${m.method}`);
  };
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "modern";
  const send = (m: Msg) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const handle = handler(mode, send, (code) => process.exit(code));
  process.stderr.write(`fixture MCP server (${mode}) starting\n`);
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      void handle(JSON.parse(line)).then((r) => r && send(r));
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
