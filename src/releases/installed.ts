import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { childEnv } from "../childEnv.js";
import { resolveTarget } from "./versions.js";

export interface Installed {
  version: string;
  /** Where it was found: a command's output or a project file. */
  source: string;
}

/** Version commands for tools, run without a shell and with fixed arguments. */
const CLI: Record<string, { bin: string; args: string[]; pattern: RegExp }> = {
  flutter: { bin: "flutter", args: ["--version"], pattern: /Flutter (\S+)/ },
  dart: { bin: "dart", args: ["--version"], pattern: /Dart SDK version: (\S+)/ },
  node: { bin: "node", args: ["--version"], pattern: /v?(\d\S*)/ },
  npm: { bin: "npm", args: ["--version"], pattern: /(\d\S*)/ },
  pnpm: { bin: "pnpm", args: ["--version"], pattern: /(\d\S*)/ },
  bun: { bin: "bun", args: ["--version"], pattern: /(\d\S*)/ },
  deno: { bin: "deno", args: ["--version"], pattern: /deno (\S+)/ },
  python: { bin: "python3", args: ["--version"], pattern: /Python (\S+)/ },
  php: { bin: "php", args: ["--version"], pattern: /PHP (\S+)/ },
  composer: { bin: "composer", args: ["--version"], pattern: /Composer version (\S+)/ },
  go: { bin: "go", args: ["version"], pattern: /go(\d[\w.]*)/ },
  rust: { bin: "rustc", args: ["--version"], pattern: /rustc (\S+)/ },
  postgresql: { bin: "psql", args: ["--version"], pattern: /(\d+(\.\d+)+)/ },
  docker: { bin: "docker", args: ["--version"], pattern: /version (\d[\w.]*)/ },
  git: { bin: "git", args: ["--version"], pattern: /git version (\S+)/ },
  ollama: { bin: "ollama", args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ },
};
const CLI_ALIASES: Record<string, string> = { nodejs: "node", "node.js": "node", python3: "python", golang: "go", rustc: "rust", postgres: "postgresql", psql: "postgresql" };

/** Package names are passed to files and commands, so keep them to registry-safe characters. */
const SAFE_NAME = /^@?[\w.-]+(\/[\w.-]+)?$/;

/**
 * What is installed here, as opposed to the latest release: the tool on PATH and/or the
 * version the project resolves (node_modules, pubspec.lock, composer.lock, FVM pin, pip).
 */
export async function installedVersions(name: string, cwd: string, ecosystem?: string): Promise<Installed[]> {
  if (!SAFE_NAME.test(name) || name.split("/").some((part) => part === "." || part === "..")) throw new Error(`invalid package name: ${name}`);
  const key = CLI_ALIASES[name.toLowerCase()] ?? name.toLowerCase();
  let pkg = name;
  let eco = ecosystem?.toLowerCase();
  try {
    const t = resolveTarget(name, ecosystem);
    pkg = t.pkg;
    eco = t.ecosystem;
  } catch {
    // unknown names are still looked up in project files below
  }

  const checks: Promise<Installed | null>[] = [];
  if (CLI[key] && (!ecosystem || ["flutter", "dart", "node", "python", "php", "go", "postgresql", "github"].includes(eco ?? ""))) {
    checks.push(fromCli(CLI[key], cwd));
  }
  if (key === "flutter") checks.push(fromFvm(cwd));
  if (key === "flutter" || key === "dart") checks.push(fromPubspecSdk(cwd, key));
  if (!eco || eco === "npm") checks.push(fromNodeModules(cwd, pkg));
  if (!eco || eco === "pub") checks.push(fromPubspecLock(cwd, pkg));
  if (!eco || eco === "packagist") checks.push(fromComposerLock(cwd, pkg));
  if (eco === "pypi") checks.push(fromPip(pkg));
  return (await Promise.all(checks)).filter((x): x is Installed => x !== null);
}

function fromCli(cli: { bin: string; args: string[]; pattern: RegExp }, cwd: string): Promise<Installed | null> {
  return new Promise((resolve) => {
    execFile(cli.bin, cli.args, { cwd, timeout: 30_000, env: childEnv() }, (err, stdout, stderr) => {
      const m = cli.pattern.exec(`${stdout}\n${stderr}`);
      resolve(!err && m ? { version: m[1], source: `${cli.bin} ${cli.args.join(" ")}` } : null);
    });
  });
}

async function readText(file: string): Promise<string | null> {
  return fs.readFile(file, "utf8").catch(() => null);
}

/** Parse a project file, treating a broken one like a missing one. */
function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function fromNodeModules(cwd: string, pkg: string): Promise<Installed | null> {
  const v = parseJson<{ version?: string }>(await readText(path.join(cwd, "node_modules", pkg, "package.json")))?.version;
  if (v) return { version: v, source: `node_modules/${pkg}/package.json` };
  const json = parseJson<Record<string, Record<string, string> | undefined>>(await readText(path.join(cwd, "package.json")));
  if (!json) return null;
  const range = json.dependencies?.[pkg] ?? json.devDependencies?.[pkg] ?? json.peerDependencies?.[pkg];
  return range ? { version: range, source: "package.json (declared range; not installed)" } : null;
}

async function fromPubspecLock(cwd: string, pkg: string): Promise<Installed | null> {
  const text = await readText(path.join(cwd, "pubspec.lock"));
  const m = text && new RegExp(`\\n  ${escape(pkg)}:\\n(?:    .*\\n)*?    version: "([^"]+)"`).exec(text);
  return m ? { version: m[1], source: "pubspec.lock" } : null;
}

async function fromPubspecSdk(cwd: string, sdk: string): Promise<Installed | null> {
  const lock = await readText(path.join(cwd, "pubspec.lock"));
  const m = lock && new RegExp(`\\nsdks:\\n(?:  .*\\n)*?  ${sdk}: "([^"]+)"`).exec(lock);
  return m ? { version: m[1], source: "pubspec.lock sdks (constraint the project resolved against)" } : null;
}

async function fromFvm(cwd: string): Promise<Installed | null> {
  for (const file of [".fvmrc", ".fvm/fvm_config.json"]) {
    const text = await readText(path.join(cwd, file));
    if (!text) continue;
    try {
      const json = JSON.parse(text) as { flutter?: string; flutterSdkVersion?: string };
      const v = json.flutter ?? json.flutterSdkVersion;
      if (v) return { version: v, source: `${file} (FVM pin for this project)` };
    } catch {
      // not JSON; ignore
    }
  }
  return null;
}

async function fromComposerLock(cwd: string, pkg: string): Promise<Installed | null> {
  const lock = parseJson<{ packages?: { name: string; version: string }[]; "packages-dev"?: { name: string; version: string }[] }>(
    await readText(path.join(cwd, "composer.lock")),
  );
  if (!lock) return null;
  const hit = [...(lock.packages ?? []), ...(lock["packages-dev"] ?? [])].find((p) => p.name === pkg.toLowerCase());
  return hit ? { version: hit.version.replace(/^v/, ""), source: "composer.lock" } : null;
}

async function fromPip(pkg: string): Promise<Installed | null> {
  // `python3 -m` looks in the working directory first, so a project could ship its own pip/:
  // run it from a new empty directory (-I would also hide `pip install --user` packages).
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "ngobe-pip-"));
  try {
    return await new Promise<Installed | null>((resolve) => {
      execFile("python3", ["-m", "pip", "show", pkg], { cwd: empty, timeout: 30_000, env: childEnv() }, (err, stdout) => {
        const m = /^Version: (\S+)/m.exec(stdout);
        resolve(!err && m ? { version: m[1], source: "python3 -m pip show" } : null);
      });
    });
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
