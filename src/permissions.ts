import type { Args, Tool } from "./types.js";
import type { UI } from "./ui.js";

// Commands that are safe to auto-run, provided they contain no shell metacharacters.
const SAFE_BASH = /^(ls|pwd|git status|git diff|git log|cat|head|tail|wc)(\s|$)/;
const SHELL_META = /[;&|<>`$()]/;

export class Permissions {
  private always = new Set<string>();

  constructor(
    private ui: UI,
    private yolo: boolean,
  ) {}

  async check(tool: Tool, args: Args): Promise<boolean> {
    if (tool.risk === "safe" || this.yolo) return true;

    if (tool.name === "bash") {
      const cmd = String(args.command ?? "").trim();
      if (SAFE_BASH.test(cmd) && !SHELL_META.test(cmd)) return true;
    }
    if (this.always.has(tool.name)) return true;

    const summary = tool.describe?.(args) ?? tool.name;
    const hint = tool.name === "bash" ? "[y/n]" : "[y/n/a=always for this tool]";
    const answer = (await this.ui.confirm(`  allow ${summary}? ${hint} `)).trim().toLowerCase();

    // Never grant blanket approval for shell access.
    if (answer === "a" && tool.name !== "bash") {
      this.always.add(tool.name);
      return true;
    }
    return answer === "y" || answer === "yes" || answer === "a";
  }
}
