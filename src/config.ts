import { parseArgs } from "node:util";

export interface Config {
  baseURL: string;
  apiKey: string;
  model: string;
  maxTurns: number;
  maxContextChars: number;
  cwd: string;
  yolo: boolean;
}

const HELP = `Usage: mugamba [options] [prompt]

Options:
  -m, --model <name>     Model name (env: MUGAMBA_MODEL)
      --base-url <url>   OpenAI-compatible endpoint (env: MUGAMBA_BASE_URL)
      --yolo             Skip permission prompts (dangerous)
  -h, --help             Show this help

Env: MUGAMBA_BASE_URL, MUGAMBA_API_KEY, MUGAMBA_MODEL, MUGAMBA_MAX_TURNS (default 40),
     MUGAMBA_MAX_CONTEXT_CHARS (default 200000; at ~4 chars per token, lower it to fit
     small local context windows)
Defaults point at a local Ollama server.
With a prompt argument the agent runs once and exits; otherwise it starts a REPL.`;

/** A positive integer from the environment; exits with a message naming the variable if invalid. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${name} must be a positive integer (got "${raw}")`);
    process.exit(1);
  }
  return n;
}

export function loadConfig(): { config: Config; prompt: string } {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: "string", short: "m" },
      "base-url": { type: "string" },
      yolo: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const config: Config = {
    baseURL: values["base-url"] ?? process.env.MUGAMBA_BASE_URL ?? "http://localhost:11434/v1",
    apiKey: process.env.MUGAMBA_API_KEY ?? "not-needed",
    model: values.model ?? process.env.MUGAMBA_MODEL ?? "qwen3-coder",
    maxTurns: envInt("MUGAMBA_MAX_TURNS", 40),
    maxContextChars: envInt("MUGAMBA_MAX_CONTEXT_CHARS", 200_000),
    cwd: process.cwd(),
    yolo: values.yolo ?? false,
  };
  return { config, prompt: positionals.join(" ").trim() };
}
