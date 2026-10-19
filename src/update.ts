import { execFile } from "node:child_process";
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

/** `ngobe update`: to the latest release, or to NGOBE_VERSION (which may also be older). */
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
      console.log("Update with: npm install -g @ngobe-ai/ngobe@latest");
      return 0;
    case "homebrew":
      console.log("Update with: brew upgrade ngobe");
      return 0;
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
  const how = { binary: "ngobe update", homebrew: "brew upgrade ngobe", npm: "npm install -g @ngobe-ai/ngobe@latest", source: "git pull && bun install && bun run build" }[installMethod()];
  return `ngobe ${latest} is available (you have ${VERSION}); update with: ${how}`;
}

