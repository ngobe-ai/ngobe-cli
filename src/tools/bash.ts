import { spawn } from "node:child_process";
import { classifyCommand } from "../permissions.js";
import type { Tool } from "../types.js";
import { optInt, reqStr } from "./util.js";

// Long output keeps its start and its end (test summaries and errors are usually last).
const HEAD = 50_000;
const TAIL = 50_000;
// Ngobe's own credentials are not the commands' business (and `echo $X` would hand them to the model).
const SCRUBBED_ENV = ["NGOBE_API_KEY", "MUGAMBA_API_KEY", "NGOBE_BRAVE_API_KEY", "NGOBE_TAVILY_API_KEY", "BRAVE_API_KEY", "TAVILY_API_KEY", "GITHUB_TOKEN", "GH_TOKEN"];

export const bash: Tool = {
  name: "bash",
  description:
    "Run a shell command in the project directory (tests, builds, git, etc). Returns exit code and combined stdout/stderr. Commands time out after 120 seconds by default.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout_seconds: { type: "integer", description: "Default 120", minimum: 1, maximum: 3600 },
    },
    required: ["command"],
  },
  risk: "exec",
  needs(a) {
    const { level } = classifyCommand(String(a.command ?? ""));
    return level === "safe" ? "none" : level === "dangerous" ? "explicit" : "approval";
  },
  timeoutMs: 0, // enforces timeout_seconds itself and kills the whole process group
  describe: (a) => `run: ${a.command}`,
  run(args, ctx) {
    const command = reqStr(args, "command");
    const timeoutMs = (optInt(args, "timeout_seconds") ?? 120) * 1000;

    return new Promise<string>((resolve) => {
      // detached = own process group, so a timeout or Ctrl+C can kill everything the
      // command started. Killing only bash leaves its children running and holding the pipes.
      const env = { ...process.env };
      for (const key of SCRUBBED_ENV) delete env[key];
      const child = spawn("bash", ["-c", command], {
        cwd: ctx.cwd,
        detached: true,
        env,
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
