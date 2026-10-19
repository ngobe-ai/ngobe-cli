import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext } from "../types.js";
import { reqStr, isSecretPath } from "./util.js";
import { assertPatternInside, findFiles } from "./glob.js";

const MAX_MATCHES = 100;
// Secret files ripgrep would otherwise search (dotfiles like .env are already skipped as hidden).
const RG_SECRET_EXCLUDES = ["*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.kdbx", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json"];

export const grep: Tool = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns path:line:text, up to 100 matches. Skips .gitignored, hidden and secret files.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression" },
      glob: { type: "string", description: 'Limit to files matching this glob (default "**/*")' },
    },
    required: ["pattern"],
  },
  risk: "safe",
  describe: (a) => `grep /${a.pattern}/${a.glob ? " in " + a.glob : ""}`,
  async run(args, ctx) {
    const pattern = reqStr(args, "pattern");
    const re = new RegExp(pattern); // invalid patterns go back to the model as an error
    const glob = typeof args.glob === "string" && args.glob ? args.glob : "**/*";
    assertPatternInside(glob, ctx.cwd);

    const hits = (hasRipgrep() && (await ripgrep(pattern, glob, ctx))) || (await jsGrep(re, glob, ctx));
    if (hits.length === 0) return "No matches.";
    return hits.join("\n") + (hits.length >= MAX_MATCHES ? "\n[match limit reached]" : "");
  },
};

let rgAvailable: boolean | undefined;
function hasRipgrep(): boolean {
  rgAvailable ??= spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
  return rgAvailable;
}

/** ripgrep, or null when it can't handle the pattern (its regex dialect lacks lookaround and backreferences). */
function ripgrep(pattern: string, glob: string, ctx: ToolContext): Promise<string[] | null> {
  const args = ["--line-number", "--no-heading", "--with-filename", "--color", "never", "--max-columns", "300"];
  if (glob !== "**/*") args.push("-g", glob);
  for (const g of RG_SECRET_EXCLUDES) args.push("-g", `!${g}`);
  args.push("-e", pattern, "--", ".");

  return new Promise((resolve) => {
    const child = spawn("rg", args, { cwd: ctx.cwd, signal: ctx.signal, stdio: ["ignore", "pipe", "ignore"] });
    const hits: string[] = [];
    let buffer = "";
    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const hit = line.replace(/^\.\//, "");
        if (isSecretPath(hit.slice(0, hit.indexOf(":")))) continue;
        hits.push(trimHit(hit));
        if (hits.length >= MAX_MATCHES) {
          child.kill();
          break;
        }
      }
    });
    child.on("error", () => resolve(null));
    // 0 = matches, 1 = none, 2 = error (bad regex, unreadable file); with hits, an unreadable file doesn't matter.
    child.on("close", (code) => resolve(code === 2 && hits.length === 0 ? null : hits));
  });
}

async function jsGrep(re: RegExp, glob: string, ctx: ToolContext): Promise<string[]> {
  const files = await findFiles(glob, ctx.cwd);
  const hits: string[] = [];
  for (const file of files.sort()) {
    if (hits.length >= MAX_MATCHES) break;
    if (isSecretPath(file)) continue;
    const abs = path.join(ctx.cwd, file);
    let text: string;
    try {
      const stat = await fs.lstat(abs);
      if (stat.isSymbolicLink() || stat.size > 1_000_000) continue; // links may point outside the project
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue; // binary
    const lines = text.split("\n");
    for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
      // Only the start of very long lines (minified code) is searched, which also bounds a slow regex.
      if (re.test(lines[i].length > 2000 ? lines[i].slice(0, 2000) : lines[i])) hits.push(trimHit(`${file}:${i + 1}:${lines[i]}`));
    }
  }
  return hits;
}

/** Keep path:line plus the first 200 characters of the matched line. */
function trimHit(hit: string): string {
  const m = /^([^:]*:\d+:)(.*)$/.exec(hit);
  return m ? m[1] + m[2].slice(0, 200) : hit.slice(0, 300);
}
