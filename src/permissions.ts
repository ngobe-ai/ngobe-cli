import type { Mode } from "./config.js";
import { isSecretPath } from "./tools/util.js";
import type { Args, Need, NeedContext, Tool } from "./types.js";
import { printable, type Ui } from "./ui.js";

// Read-only commands that may run without asking, provided every word passes isPlainWord.
const SAFE_BASH = /^(ls|pwd|git status|git diff|git log|git show|cat|head|tail|wc) /;
// No quotes, globs, expansions, redirects, separators or newlines: the shell sees exactly these words.
const PLAIN_WORD = /^[\w./@:=+,%-]+$/;

function isPlainWord(word: string): boolean {
  if (!PLAIN_WORD.test(word) || word.startsWith("--output")) return false; // git diff/log --output writes a file
  // Paths may also follow "=" or ":" (e.g. --flag=/etc/passwd); none may leave the project.
  return word.split(/[=:]/).every((part) => !part.startsWith("/") && !part.split("/").includes(".."));
}

/**
 * Commands that need explicit confirmation every time, in every mode. Program names count
 * wherever a command can start (after a newline, ; | & ( { `, a quote as in bash -c '…', a
 * backslash, or a directory as in /bin/rm), so "if x; then rm …" and "sh -c 'sudo …'" are
 * caught. A heuristic, not a sandbox: auto mode trusts it, so run auto mode inside a
 * container or a disposable checkout.
 */
const DANGEROUS: [RegExp, string][] = [
  [at("sudo|doas|su|pkexec"), "runs with elevated privileges"],
  [or(at("rm|rmdir|unlink|shred|truncate|srm"), /\s-delete\b|-exec(dir)?\s+(\S*\/)?(rm|shred|unlink)\b/), "deletes files"],
  [git("push"), "publishes to a remote"],
  [
    git(String.raw`reset\s+--hard|clean|rebase|restore|filter-branch|filter-repo|update-ref|stash\s+(drop|clear)|checkout\s+(--|\.)|branch\s+-[dD]\b|tag\s+-d\b`),
    "discards or rewrites git history or changes",
  ],
  [git("commit"), "creates a commit"],
  [or(git("config"), /(^|[\s'"=>])\.git\/(hooks|config)\b/), "changes git configuration or hooks"],
  [
    or(
      /\b(npm|pnpm|yarn|bun)(\s+-\S+)*\s+(i|install|add|remove|uninstall|update|upgrade|publish|link)\b|\bpip3?(\s+-\S+)*\s+(install|uninstall)\b|-m\s+pip(\s+-\S+)*\s+(install|uninstall)\b|\bcomposer(\s+-\S+)*\s+(require|remove|install|update)\b|\b(flutter|dart)\s+pub\s+(add|remove|upgrade|get)\b|\bcargo\s+(install|add|publish)\b|\bgo\s+(install|get)\b|\bgem\s+install\b/,
      at("apt|apt-get|yum|dnf|brew|snap|pacman"),
    ),
    "installs or removes dependencies",
  ],
  [
    or(
      /\bartisan\s+(migrate|db:)|\bprisma\s+(migrate|db\s+push)|\balembic\s+(upgrade|downgrade)|\brails\s+db:|\b(knex|sequelize)\s+(migrate|db:)|\bdrizzle-kit\s+(push|migrate)/,
      at("psql|mysql|mongosh|redis-cli|sqlite3"),
    ),
    "changes a database",
  ],
  [
    or(
      at("kubectl|helm|terraform|pulumi|vercel|netlify|flyctl|heroku|ansible-playbook"),
      /\bfirebase\s+deploy\b|\bfly\s+deploy\b|\bdocker\s+(push|rm|rmi|kill|stop|system\s+prune|volume\s+rm|compose\s+down)\b/,
    ),
    "deploys or changes infrastructure",
  ],
  [
    or(
      at("systemctl|service|ufw|iptables|nft|crontab|mkfs|mount|umount|shutdown|reboot|kill|killall|pkill|chown"),
      /\bchmod\s+-\w*R|\bdd\s+if=/,
    ),
    "changes the system",
  ],
  [/\b(curl|wget)\b[^|]*\|\s*(\S*\/)?(ba|z)?sh\b|\b(ba|z)?sh\s+<\(\s*(curl|wget)\b|\$\(\s*(curl|wget)\b/, "runs a downloaded script"],
  [at("ssh|scp|rsync|sftp"), "connects to a remote host"],
  [/\bcurl\b.*(-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s|\s-F\s|--upload-file|\s-T\s)/, "sends data over the network"],
  [or(at("env|printenv"), /\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)\w*/i), "may expose secrets"],
  [/>\s*(\/(?!dev\/null)|~)/, "writes outside the project"],
];

/** A program name wherever a command can start, optionally behind a directory. */
function at(names: string): RegExp {
  return new RegExp(String.raw`(^|[\s;&|(){}\x60'"\\]|\$\()(\S*/)?(${names})(?=$|[\s;&|)'"\x60])`);
}

/** A git subcommand, allowing global options before it (git -C dir push, git -c k=v push). */
function git(sub: string): RegExp {
  return new RegExp(String.raw`\bgit(\s+-\S+(\s+[^\s-]\S*)?)*\s+(${sub})`);
}

function or(...res: RegExp[]): RegExp {
  return new RegExp(res.map((r) => r.source).join("|"), res.some((r) => r.flags.includes("i")) ? "i" : "");
}

/** Any word that names a secret file (.env, *.key, credentials.json, id_rsa, …), including after = or :. */
function mentionsSecretFile(cmd: string): boolean {
  return cmd.split(/[\s'"=:<>|;&(){}\x60]+/).some((word) => word && isSecretPath(word));
}

export type CommandClass = "safe" | "normal" | "dangerous";

export function classifyCommand(command: string): { level: CommandClass; reason?: string } {
  const cmd = command.trim();
  for (const [re, reason] of DANGEROUS) if (re.test(cmd)) return { level: "dangerous", reason };
  if (mentionsSecretFile(cmd)) return { level: "dangerous", reason: "may expose secrets" };
  if (SAFE_BASH.test(cmd + " ") && cmd.split(/ +/).every(isPlainWord)) return { level: "safe" };
  return { level: "normal" };
}

/** Tools offered to the model in a mode: ask and plan never get tools that change things. */
export function toolsForMode(tools: Tool[], mode: Mode): Tool[] {
  return tools.filter(
    (t) => (!t.modes || t.modes.includes(mode)) && (mode === "edit" || mode === "auto" || t.risk === "safe" || t.risk === "network"),
  );
}

/** "npm test", "bun run" … the part of a command that "always" approves (program + subcommand). */
export function commandPrefix(command: string): string {
  return command.trim().split(/\s+/).slice(0, 2).join(" ");
}

export function needOf(tool: Tool, args: Args, ctx?: NeedContext): Need {
  return tool.needs?.(args, ctx) ?? (tool.risk === "write" || tool.risk === "exec" ? "approval" : "none");
}

export class Permissions {
  private always = new Set<string>();
  /** The folder and the request being worked on (set by the agent at the start of each run). */
  private context: NeedContext = { cwd: process.cwd() };
  /** Command prefixes approved with "always" (bash only, never dangerous commands). */
  private prefixes = new Set<string>();

  constructor(
    private ui: Ui,
    private mode: Mode,
  ) {}

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  setRequest(cwd: string, request: string): void {
    this.context = { cwd, request };
  }

  /** What a call needs, given the current folder and request. */
  need(tool: Tool, args: Args): Need {
    return needOf(tool, args, this.context);
  }

  /** What "always" has approved this session (/permissions). */
  get approvals(): { tools: string[]; commands: string[] } {
    return { tools: [...this.always], commands: [...this.prefixes] };
  }

  revokeAll(): void {
    this.always.clear();
    this.prefixes.clear();
  }

  /** Whether a call may run; prompts the user when it needs approval. */
  async check(tool: Tool, args: Args): Promise<boolean> {
    if (!toolsForMode([tool], this.mode).length) return false;
    const need = needOf(tool, args, this.context);
    if (need === "none") return true;
    if (need === "approval" && (this.mode === "auto" || this.always.has(tool.name))) return true;
    const command = tool.name === "bash" ? String(args.command ?? "").trim() : "";
    if (need === "approval" && command && [...this.prefixes].some((p) => command === p || command.startsWith(`${p} `))) return true;

    const explicit = need === "explicit";
    const reason = tool.name === "bash" ? classifyCommand(String(args.command ?? "")).reason : undefined;
    const summary = printable(tool.describe?.(args) ?? tool.name);
    const prompt = `${explicit ? "⚠ " : ""}allow ${summary}?${reason ? ` (${reason})` : ""}`;
    const answer = (await this.ui.confirm(prompt)).trim().toLowerCase();

    // "always" lasts for this session: per tool, or for shell commands per program + subcommand
    // ("npm test"). It never covers explicit-only actions (dangerous commands, secrets, commits).
    if (answer === "a" && !explicit) {
      if (tool.name === "bash") this.prefixes.add(commandPrefix(command));
      else if (tool.risk !== "exec") this.always.add(tool.name);
      return true;
    }
    return answer === "y" || answer === "yes" || answer === "a";
  }
}
