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
      const child = spawn("bash", ["-c", command], {
        cwd: ctx.cwd,
        signal: ctx.signal,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let output = "";
      const collect = (d: Buffer) => {
        if (output.length < MAX_CAPTURE) output += d.toString();
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve(`Error: ${err.message}\n${output}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const status = timedOut ? `timed out after ${timeoutMs / 1000}s` : `exit code ${code}`;
        resolve(`${status}\n${output}`);
      });
    });
  },
};
