import { spawn } from "node:child_process";
import type { Tool } from "../types.js";
import { optInt, reqStr } from "./util.js";

const MAX_CAPTURE = 100_000;

export const bash: Tool = {
  name: "bash",
  description:
    "Run a shell command in the project directory (tests, builds, git, etc). Returns exit code and combined stdout/stderr. Commands time out after 120 seconds by default.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout_seconds: { type: "integer", description: "Default 120" },
    },
    required: ["command"],
  },
  risk: "exec",
  describe: (a) => `run: ${a.command}`,
  run(args, ctx) {
    const command = reqStr(args, "command");
    const timeoutMs = (optInt(args, "timeout_seconds") ?? 120) * 1000;

    return new Promise<string>((resolve) => {
      // detached = own process group, so a timeout or Ctrl+C can kill everything the
      // command started. Killing only bash leaves its children running and holding the pipes.
      const child = spawn("bash", ["-c", command], {
        cwd: ctx.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      const collect = (d: Buffer) => {
        if (output.length < MAX_CAPTURE) output += d.toString();
      };
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
        resolve(`Error: ${err.message}\n${output}`);
      });
      child.on("close", (code) => {
        cleanup();
        resolve(`${stopped ?? `exit code ${code}`}\n${output}`);
      });
    });
  },
};
