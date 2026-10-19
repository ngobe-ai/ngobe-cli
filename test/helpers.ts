import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import type { Todo, ToolView } from "../src/types.js";
import type { Activity, RunSummary, Ui } from "../src/ui.js";

/** A full config with isolated state/cache directories and no search providers. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ngobe-cfg-"));
  const { config } = loadConfig([], { XDG_CONFIG_HOME: path.join(dir, "config"), HOME: dir });
  return { ...config, stateDir: path.join(dir, "state"), cacheDir: path.join(dir, "cache"), memory: false, ...overrides };
}

/** A Ui that records everything and answers approval prompts with `answer`. */
export function recordingUi(answer = "n") {
  const log = {
    prompts: [] as string[],
    text: "",
    /** Every toolUpdate, in order (a running view, then the same id finished). */
    views: [] as ToolView[],
    activities: [] as (Activity | null)[],
    todos: [] as Todo[][],
    runs: [] as RunSummary[],
    notes: [] as string[],
  };
  const ui: Ui = {
    ask: async () => {
      throw new Error("no input in tests");
    },
    confirm: async (p) => {
      log.prompts.push(p);
      return answer;
    },
    write: (c) => {
      log.text += c;
    },
    endTurn: () => {},
    info: (t) => log.notes.push(t),
    warn: (t) => log.notes.push(t),
    error: (t) => log.notes.push(t),
    toolUpdate: (v) => log.views.push(structuredClone(v)),
    activity: (a) => log.activities.push(a && { ...a }),
    todos: (l) => log.todos.push(l),
    runDone: (s) => log.runs.push(s),
    onInterrupt: () => {},
    close: () => {},
  };
  return { ui, log };
}

export interface FakeTurn {
  content?: string;
  toolCalls?: { name: string; arguments: string }[];
}

/**
 * An OpenAI-compatible streaming endpoint that plays back scripted turns, one per request,
 * and records the request bodies. `onRequest` can override the response (e.g. return a 400).
 */
export function fakeModel(turns: FakeTurn[], onRequest?: (body: Record<string, unknown>, n: number) => Response | Promise<Response> | undefined) {
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "test", meta: { size: 4.5 * 1024 ** 3, n_params: 8e9 } }] });
      }
      const body = (await req.json()) as Record<string, unknown>;
      requests.push(body);
      const override = await onRequest?.(body, requests.length);
      if (override) return override;
      const turn = turns[Math.min(requests.length - 1, turns.length - 1)] ?? { content: "" };
      if (body.stream === false || body.stream === undefined) {
        return Response.json({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "fake-model",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: turn.content ?? null,
                tool_calls: turn.toolCalls?.map((c, i) => ({ id: `c${i}`, type: "function", function: c })),
              },
            },
          ],
        });
      }
      const chunks: unknown[] = [];
      const chunk = (delta: unknown) => ({ id: "x", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: null }] });
      for (const piece of (turn.content ?? "").match(/[\s\S]{1,7}/g) ?? []) chunks.push(chunk({ content: piece }));
      turn.toolCalls?.forEach((c, i) => {
        chunks.push(chunk({ tool_calls: [{ index: i, id: `call_${i}`, type: "function", function: { name: c.name, arguments: "" } }] }));
        chunks.push(chunk({ tool_calls: [{ index: i, function: { arguments: c.arguments } }] }));
      });
      const body2 = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(body2, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { baseURL: `http://localhost:${server.port}/v1`, requests, stop: () => server.stop(true) };
}

export function tmpDir(prefix = "ngobe-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
