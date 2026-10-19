import type { Args, Tool } from "./types.js";
import type { Ui } from "./ui.js";

// Read-only commands that may run without asking, provided every word passes isPlainWord.
const SAFE_BASH = /^(ls|pwd|git status|git diff|git log|cat|head|tail|wc) /;
// No quotes, globs, expansions, redirects, separators or newlines: the shell sees exactly these words.
const PLAIN_WORD = /^[\w./@:=+,%-]+$/;

function isPlainWord(word: string): boolean {
  if (!PLAIN_WORD.test(word) || word.startsWith("--output")) return false; // git diff/log --output writes a file
  // Paths may also follow "=" or ":" (e.g. --flag=/etc/passwd); none may leave the project.
  return word.split(/[=:]/).every((part) => !part.startsWith("/") && !part.split("/").includes(".."));
}

function isAutoAllowed(command: string): boolean {
  return SAFE_BASH.test(command + " ") && command.split(/ +/).every(isPlainWord);
}

export class Permissions {
  private always = new Set<string>();

  constructor(
    private ui: Ui,
    private yolo: boolean,
  ) {}

  async check(tool: Tool, args: Args): Promise<boolean> {
    if (tool.risk === "safe" || this.yolo) return true;

    if (tool.name === "bash" && isAutoAllowed(String(args.command ?? "").trim())) return true;
    if (this.always.has(tool.name)) return true;

    const summary = tool.describe?.(args) ?? tool.name;
    const answer = (await this.ui.confirm(`allow ${summary}?`)).trim().toLowerCase();

    // Never grant blanket approval for shell access.
    if (answer === "a" && tool.name !== "bash") {
      this.always.add(tool.name);
      return true;
    }
    return answer === "y" || answer === "yes" || answer === "a";
  }
}
