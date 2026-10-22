import crypto from "node:crypto";
import type { Args, Need, Tool } from "../types.js";
import type { CallToolResult, ContentItem, McpClient, McpToolDef } from "./client.js";
import type { McpServerSpec } from "./config.js";

/**
 * MCP tools as ngobe tools: named mcp__<server>__<tool> (the names Claude Code uses, so custom
 * agents listing them work in both), with the server's schema, approval from its annotations and
 * the user's autoApprove list, and results turned into text for the model.
 */

const MAX_NAME = 64; // OpenAI function names: ^[a-zA-Z0-9_-]{1,64}$
const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

/** mcp__server__tool, made safe for function names; a long one keeps a short hash of the original. */
export function mcpToolName(server: string, tool: string): string {
  const name = `mcp__${sanitize(server)}__${sanitize(tool)}`;
  if (name.length <= MAX_NAME) return name;
  const hash = crypto.createHash("sha256").update(`${server}/${tool}`).digest("hex").slice(0, 6);
  return `${name.slice(0, MAX_NAME - 7)}_${hash}`;
}

/** The first sentence, at most `max` characters: tool definitions are re-read on every cold start. */
export function firstSentence(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  const sentence = /^.+?[.!?](?=\s|$)/.exec(t)?.[0] ?? t;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).trimEnd()}…`;
}

// Keys that only cost tokens for the model, or are for the transport (x-mcp-header).
const DROP = new Set(["$schema", "$comment", "examples", "x-mcp-header", "title"]);

/** The schema the model sees: noise dropped; in the lean profile, descriptions cut to a sentence. */
export function modelSchema(schema: unknown, lean: boolean): Record<string, unknown> {
  const clean = (node: unknown, inProperties: boolean): unknown => {
    if (Array.isArray(node)) return node.map((n) => clean(n, false));
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      // Inside "properties", keys are parameter names, not schema keywords.
      if (!inProperties && DROP.has(k)) continue;
      if (!inProperties && k === "description" && typeof v === "string") out[k] = lean ? firstSentence(v, 120) : v.slice(0, 500);
      else out[k] = clean(v, k === "properties" && !inProperties);
    }
    return out;
  };
  const s = clean(schema, false) as Record<string, unknown> | null;
  // Tool arguments are always a JSON object.
  return s && typeof s === "object" && !Array.isArray(s) ? { ...s, type: "object", properties: s.properties ?? {} } : { type: "object", properties: {} };
}

function size(base64: string | undefined): string {
  const bytes = Math.floor(((base64 ?? "").length * 3) / 4);
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const MAX_IMAGE_BASE64 = 5_000_000;

/** An image item the model can be shown: a common format, a sane size (browser screenshots are). */
function showable(c: ContentItem): boolean {
  return c.type === "image" && !!c.data && /^image\/(png|jpeg|gif|webp)$/.test(c.mimeType ?? "") && c.data.length <= MAX_IMAGE_BASE64;
}

function itemText(c: ContentItem, shown: boolean): string {
  switch (c.type) {
    case "text":
      return c.text ?? "";
    case "image":
    case "audio":
      return `[${c.type}: ${c.mimeType ?? "unknown type"}, ${size(c.data)}; ${shown && showable(c) ? "shown to you after the tool results" : "not shown to the model"}]`;
    case "resource_link":
      return `[resource: ${c.name ?? c.uri}${c.uri && c.name ? ` <${c.uri}>` : ""}${c.mimeType ? ` (${c.mimeType})` : ""}]${c.description ? ` ${c.description}` : ""}`;
    case "resource": {
      const r = c.resource ?? {};
      if (typeof r.text === "string") return `[resource ${r.uri ?? ""}]\n${r.text}`;
      return `[resource ${r.uri ?? ""}: ${r.mimeType ?? "binary"}, ${size(r.blob)}]`;
    }
    default:
      return `[${c.type} content]`;
  }
}

/**
 * What the model reads: the text items (and placeholders for media), else the structured result.
 * `shown`: the images go to the model separately (it sees images), so their placeholders say so.
 */
export function resultText(result: CallToolResult, shown = false): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const parts = content.map((c) => itemText(c, shown)).filter((t) => t !== "");
  const hasText = content.some((c) => (c.type === "text" && c.text) || typeof c.resource?.text === "string");
  if (!hasText && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return parts.join("\n").trim();
}

/** How much a call may do without asking. Annotations are the server's own claims. */
export function mcpNeed(def: McpToolDef, spec: Pick<McpServerSpec, "autoApprove">): Need {
  if (spec.autoApprove.has(def.name) || spec.autoApprove.has("*")) return "none";
  const a = def.annotations ?? {};
  if (a.readOnlyHint === true) return "none";
  return a.destructiveHint === true ? "explicit" : "approval";
}

export function toTool(client: McpClient, def: McpToolDef, lean: boolean): Tool {
  const spec = client.spec;
  const readOnly = def.annotations?.readOnlyHint === true;
  const description = (def.description ?? def.title ?? def.annotations?.title ?? def.name).trim();
  const full = description.length > 1024 ? `${description.slice(0, 1023)}…` : description;
  return {
    name: mcpToolName(spec.name, def.name),
    label: `${spec.name} - ${def.name} (MCP)`,
    description: lean ? firstSentence(description, 200) : full,
    parameters: modelSchema(def.inputSchema, lean),
    // Read-only tools are offered in ask and plan modes too; the rest change something somewhere.
    risk: readOnly ? "network" : "write",
    needs: () => mcpNeed(def, spec),
    timeoutMs: spec.toolTimeoutMs,
    describe: (args: Args) => `${spec.name} MCP tool ${def.name} ${JSON.stringify(args).slice(0, 300)}`,
    activity: () => `Calling ${spec.name}: ${def.name}`,
    async run(args, ctx) {
      const result = await client.callTool(def.name, args, ctx.signal ?? AbortSignal.timeout(spec.toolTimeoutMs));
      // A browser screenshot is seen, not described, by a model that takes images.
      if (ctx.attach) for (const c of result.content ?? []) if (showable(c)) ctx.attach({ mime: c.mimeType!, data: c.data! });
      const text = resultText(result, Boolean(ctx.attach));
      if (result.isError) throw new Error(text || `${def.name} reported an error`);
      return text || "(no output)";
    },
  };
}
