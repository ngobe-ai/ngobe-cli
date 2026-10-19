import { spawn } from "node:child_process";
import { classifyCommand } from "../permissions.js";
import type { Tool } from "../types.js";
import { killGroup } from "./processes.js";
import { optInt, reqStr } from "./util.js";

// Long output keeps its start and its end (test summaries and errors are usually last).
const HEAD = 50_000;
const TAIL = 50_000;
// Ngobe's own credentials are not the commands' business (and `echo $X` would hand them to the model).
const SCRUBBED_ENV = ["NGOBE_API_KEY", "MUGAMBA_API_KEY", "NGOBE_BRAVE_API_KEY", "NGOBE_TAVILY_API_KEY", "BRAVE_API_KEY", "TAVILY_API_KEY", "GITHUB_TOKEN", "GH_TOKEN"];

/** What a command is doing, for the status line: tests, builds, installs… */
export function commandActivity(command: string, description?: string): string {
  if (description) return description;
  const c = command.toLowerCase();
  if (/\b(test|tests|pytest|jest|vitest|mocha|phpunit|rspec)\b|\b(go|cargo|flutter|dart|bun) test\b/.test(c)) return "Running tests";
  if (/\b(build|tsc|compile|webpack|esbuild)\b/.test(c)) return "Building";
  if (/\b(lint|eslint|ruff|clippy|analyze|vet|pint|phpstan)\b/.test(c)) return "Linting";
  if (/\b(format|fmt|prettier)\b/.test(c)) return "Formatting";
  if (/\b(install|add|pub get|composer require)\b/.test(c)) return "Installing dependencies";
  if (/^\s*git\b/.test(c)) return "Running git";
  return `Running ${command.trim().split(/\s+/).slice(0, 3).join(" ")}`;
}

const SPAWN_ENV = () => {
  const env = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  return env;
};

export const bash: Tool = {
  name: "bash",
  label: "Bash",
  description:
    "Run a shell command in the project directory: tests, builds, git, package scripts. Returns the exit code and combined output. Give a short description of what it does. Times out after 120s unless timeout_seconds is set. Use run_in_background for servers and watchers, then bash_output to read them and kill_shell to stop them. Prefer read_file, grep and glob over cat, grep and find.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      description: { type: "string", description: 'What it does in a few words, e.g. "Run the unit tests"' },
      timeout_seconds: { type: "integer", description: "Default 120", minimum: 1, maximum: 3600 },
      run_in_background: { type: "boolean", description: "Start it and return at once (servers, watchers)" },
    },
    required: ["command"],
  },
  lean: {
    description: "Run a shell command (tests, builds, git). Returns the exit code and output.",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout_seconds: { type: "integer" } }, required: ["command"] },
  },
  risk: "exec",
  needs(a) {
    const { level } = classifyCommand(String(a.command ?? ""));
    return level === "safe" ? "none" : level === "dangerous" ? "explicit" : "approval";
  },
  timeoutMs: 0, // enforces timeout_seconds itself and kills the whole process group
  describe: (a) => `run: ${a.command}`,
  target: (a) => String(a.command ?? ""),
  activity: (a) => commandActivity(String(a.command ?? ""), typeof a.description === "string" ? a.description : undefined),
  summarize(a, output, ms) {
    const status = output.split("\n")[0] ?? "";
    const body = output.split("\n").slice(1).filter((l) => l.trim());
    if (a.run_in_background) return { summary: status };
    const failed = !/^exit code 0$/.test(status);
    const tail = body.slice(-3).map((text) => ({ text: text.slice(0, 160), tone: failed ? ("error" as const) : ("dim" as const) }));
    return { summary: `${status.replace(/^exit code /, "exit ")} · ${(ms / 1000).toFixed(1)}s`, preview: tail };
  },
  run(args, ctx) {
    const command = reqStr(args, "command");
    if (args.run_in_background === true) return Promise.resolve(startBackground(command, ctx.cwd));
    const timeoutMs = (optInt(args, "timeout_seconds") ?? 120) * 1000;

    return new Promise<string>((resolve) => {
      // detached = own process group, so a timeout or Ctrl+C can kill everything the
      // command started. Killing only bash leaves its children running and holding the pipes.
      const child = spawn("bash", ["-c", command], {
        cwd: ctx.cwd,
        detached: true,
        env: SPAWN_ENV(),
        stdio: ["ignore", "pipe", "pipe"],
      });

      let head = "";
      let tail = "";
      let dropped = 0;
      const collect = (d: Buffer) => {
        let s = d.toString();
        if (head.length < HEAD) {
          const room = HEAD - head.length;
          head += s.slice(0, room);
          s = s.slice(room);
        }
        if (!s) return;
        tail += s;
        if (tail.length > TAIL) {
          dropped += tail.length - TAIL;
          tail = tail.slice(-TAIL);
        }
      };
      const output = () => head + (dropped ? `\n... [${dropped} characters omitted] ...\n` : "") + tail;
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      let stopped: string | null = null;
      const stop = (reason: string) => {
        if (stopped) return;
        stopped = reason;
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL"); // negative pid = the whole group
        } catch {
          // already exited
        }
        // A process that left the group may still hold the pipes; don't wait for it.
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const timer = setTimeout(() => stop(`timed out after ${timeoutMs / 1000}s`), timeoutMs);
      const onAbort = () => stop("cancelled by user");
      if (ctx.signal?.aborted) onAbort();
      else ctx.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
      };

      child.on("error", (err) => {
        cleanup();
        resolve(`Error: ${err.message}\n${output()}`);
      });
      child.on("close", (code) => {
        cleanup();
        resolve(`${stopped ?? `exit code ${code}`}\n${output()}`);
      });
    });
  },
};

// --- background processes ------------------------------------------------------------

interface Background {
  command: string;
  pid: number;
  output: string;
  /** How much of output bash_output has already returned. */
  read: number;
  exit: number | null;
}

const background = new Map<string, Background>();
let nextShell = 1;

function startBackground(command: string, cwd: string): string {
  const id = `shell_${nextShell++}`;
  const child = spawn("bash", ["-c", command], { cwd, detached: true, env: SPAWN_ENV(), stdio: ["ignore", "pipe", "pipe"] });
  const entry: Background = { command, pid: child.pid ?? 0, output: "", read: 0, exit: null };
  const collect = (d: Buffer) => {
    entry.output += d.toString();
    if (entry.output.length > 200_000) {
      // keep the newest output; adjust what has been read accordingly
      const drop = entry.output.length - 200_000;
      entry.output = entry.output.slice(drop);
      entry.read = Math.max(0, entry.read - drop);
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("close", (code) => (entry.exit = code ?? -1));
  // Don't keep ngobe running for it (the exit hook below stops it).
  child.unref();
  for (const pipe of [child.stdout, child.stderr]) (pipe as unknown as { unref?: () => void }).unref?.();
  background.set(id, entry);
  return `started in the background as ${id} (pid ${entry.pid}). Read its output with bash_output, stop it with kill_shell.`;
}

/** Background processes die with ngobe. */
process.once("exit", () => {
  for (const b of background.values()) if (b.exit === null) killGroup(b.pid);
});

export const bashOutput: Tool = {
  name: "bash_output",
  label: "BashOutput",
  description: "New output from a background command started with bash run_in_background, and whether it is still running.",
  parameters: { type: "object", properties: { shell_id: { type: "string" } }, required: ["shell_id"] },
  aliases: { bash_id: "shell_id", id: "shell_id" },
  risk: "safe",
  activity: (a) => `Reading ${a.shell_id}`,
  summarize: (_a, output) => ({ summary: output.split("\n")[0] }),
  async run(args) {
    const id = reqStr(args, "shell_id");
    const b = background.get(id);
    if (!b) throw new Error(`no background command ${id}; running: ${[...background.keys()].join(", ") || "none"}`);
    const fresh = b.output.slice(b.read);
    b.read = b.output.length;
    const status = b.exit === null ? "running" : `exited with code ${b.exit}`;
    return `${id} (${b.command}): ${status}\n${fresh ? fresh.slice(-20_000) : "(no new output)"}`;
  },
};

export const killShell: Tool = {
  name: "kill_shell",
  label: "KillShell",
  description: "Stop a background command started with bash run_in_background.",
  parameters: { type: "object", properties: { shell_id: { type: "string" } }, required: ["shell_id"] },
  aliases: { bash_id: "shell_id", id: "shell_id" },
  risk: "exec",
  needs: () => "none", // only stops what the agent itself started
  activity: (a) => `Stopping ${a.shell_id}`,
  async run(args) {
    const id = reqStr(args, "shell_id");
    const b = background.get(id);
    if (!b) throw new Error(`no background command ${id}`);
    if (b.exit === null) killGroup(b.pid);
    background.delete(id);
    return `stopped ${id} (${b.command})`;
  },
};
