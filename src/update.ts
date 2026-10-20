import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STANDALONE, VERSION, type LoadedConfig } from "./config.js";
import { compareVersions, latestVersion } from "./releases/versions.js";
import { bold, dim, green, yellow } from "./ui.js";

export const REPO = "ngobe-ai/ngobe-cli";

export type InstallMethod = "binary" | "homebrew" | "npm" | "source";

function real(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** How this copy was installed, which decides how it updates. */
export function installMethod(opts: { standalone?: boolean; execPath?: string; script?: string } = {}): InstallMethod {
  const standalone = opts.standalone ?? STANDALONE;
  if (standalone) return /[\\/]Cellar[\\/]ngobe[\\/]/.test(real(opts.execPath ?? process.execPath)) ? "homebrew" : "binary";
  return /[\\/]node_modules[\\/]@ngobe-ai[\\/]ngobe[\\/]/.test(real(opts.script ?? process.argv[1] ?? "")) ? "npm" : "source";
}

/** The release archive for a machine: ngobe-<os>-<arch>.tar.gz (baseline x64 build without AVX2). */
export function assetName(platform: string = process.platform, arch: string = process.arch, avx2: boolean = hasAvx2()): string {
  const osName = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  if (!osName || !cpu) throw new Error(`no prebuilt binary for ${platform}-${arch}; install with npm instead (Node 22.13+)`);
  return `ngobe-${osName}-${cpu}${osName === "linux" && cpu === "x64" && !avx2 ? "-baseline" : ""}.tar.gz`;
}

function hasAvx2(): boolean {
  try {
    return /\bavx2\b/.test(fs.readFileSync("/proc/cpuinfo", "utf8"));
  } catch {
    return true; // not Linux
  }
}

/** How a Homebrew or npm install upgrades itself; null when ngobe does it (binary) or the user does (source). */
export function upgradeCommand(method: InstallMethod): [string, string[]] | null {
  if (method === "homebrew") return ["brew", ["upgrade", "ngobe-ai/tap/ngobe"]];
  if (method === "npm") return ["npm", ["install", "-g", "@ngobe-ai/ngobe@latest"]];
  return null;
}

const CHECK_FILE = "update-check.json";
const CHECK_EVERY_MS = 24 * 3_600_000;

/** The chat looks for a new release at most once a day. */
export function dueForUpdateCheck(stateDir: string, now = Date.now()): boolean {
  try {
    const { at } = JSON.parse(fs.readFileSync(path.join(stateDir, CHECK_FILE), "utf8")) as { at?: number };
    return !(typeof at === "number" && now - at < CHECK_EVERY_MS);
  } catch {
    return true;
  }
}

export function markUpdateChecked(stateDir: string, now = Date.now()): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, CHECK_FILE), JSON.stringify({ at: now }));
  } catch {
    // a read-only state directory only means checking again next time
  }
}

/** `ngobe upgrade` (or update): to the latest release, or to NGOBE_VERSION (which may also be older). */
export async function cmdUpdate(loaded: LoadedConfig): Promise<number> {
  const pinned = process.env.NGOBE_VERSION?.replace(/^v/, "");
  const latest = pinned || (await latestVersion(REPO, "github", { config: { ...loaded.config, cacheDir: "" } })).stable?.version;
  if (!latest) throw new Error(`no release found for ${REPO}`);
  if (pinned ? VERSION === pinned : compareVersions(VERSION, latest) >= 0) {
    console.log(green(`ngobe ${VERSION} is up to date.`));
    return 0;
  }
  const method = installMethod();
  console.log(`${bold(`ngobe ${VERSION} → ${latest}`)} ${dim(`(installed via ${method})`)}`);
  switch (method) {
    case "npm":
    case "homebrew": {
      if (pinned) {
        console.log(yellow(`NGOBE_VERSION only applies to the standalone binary; ${method} installs the latest release.`));
      }
      const [cmd, args] = upgradeCommand(method)!;
      console.log(dim(`$ ${cmd} ${args.join(" ")}`));
      const code = await runInteractive(cmd, args);
      if (code !== 0) {
        console.log(yellow(`${cmd} exited with ${code}. Try it yourself: ${cmd} ${args.join(" ")}`));
        return code;
      }
      const now = (await run("ngobe", ["--version"]).catch(() => "")).trim();
      console.log(now === latest ? green(`ngobe is now ${latest}.`) : yellow(`done; \`ngobe --version\` says ${now || "nothing"} (open a new terminal if it still shows ${VERSION})`));
      return 0;
    }
    case "source":
      console.log("Update with: git pull && bun install && bun run build");
      return 0;
    case "binary":
      await replaceBinary(latest);
      return 0;
  }
}

/** Download the release for this machine, check its SHA-256, and swap it in for the running binary. */
async function replaceBinary(version: string): Promise<void> {
  const asset = assetName();
  const base = process.env.NGOBE_DOWNLOAD_BASE ?? `https://github.com/${REPO}/releases/download/v${version}`;
  const [archive, sums] = await Promise.all([download(`${base}/${asset}`), download(`${base}/SHA256SUMS`)]);
  const expected = sums
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, file]) => file === asset)?.[0];
  const actual = crypto.createHash("sha256").update(archive).digest("hex");
  if (!expected || expected !== actual) throw new Error(`checksum mismatch for ${asset}; not installing`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ngobe-update-"));
  try {
    fs.writeFileSync(path.join(tmp, asset), archive);
    await run("tar", ["-xzf", path.join(tmp, asset), "-C", tmp]);
    const target = real(process.execPath);
    const staged = `${target}.new`;
    try {
      fs.copyFileSync(path.join(tmp, "ngobe"), staged);
      fs.chmodSync(staged, 0o755);
      fs.renameSync(staged, target); // atomic on the same filesystem; the running process keeps its old inode
    } catch (err) {
      fs.rmSync(staged, { force: true });
      if ((err as NodeJS.ErrnoException).code === "EACCES" || (err as NodeJS.ErrnoException).code === "EPERM") {
        throw new Error(`no permission to replace ${target}; re-run with sudo, or reinstall with install.sh into a directory you own`);
      }
      throw err;
    }
    const installed = (await run(target, ["--version"])).trim();
    console.log(installed === version ? green(`updated ${target} to ${version}`) : yellow(`installed, but ${target} --version says ${installed}`));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`download failed: ${url} returned HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** brew and npm show their own progress and may ask for a password. */
function runInteractive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 60_000 }, (err, stdout, stderr) => (err ? reject(new Error(`${cmd} failed: ${stderr || err.message}`)) : resolve(stdout))),
  );
}

/** "ngobe X is available" for doctor, or null when current (or the check failed). */
export async function updateNotice(loaded: LoadedConfig): Promise<string | null> {
  const info = await latestVersion(REPO, "github", { config: loaded.config });
  const latest = info.stable?.version;
  if (!latest || compareVersions(VERSION, latest) >= 0) return null;
  const how = installMethod() === "source" ? "git pull && bun install && bun run build" : "ngobe upgrade";
  return `ngobe ${latest} is available (you have ${VERSION}); update with: ${how}`;
}

