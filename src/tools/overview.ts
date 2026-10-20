import fs from "node:fs/promises";
import path from "node:path";
import { detectProject } from "../project.js";
import type { Tool } from "../types.js";
import { listFiles } from "./files.js";
import { git } from "./git.js";
import { didYouMean, resolveInside, similarPaths } from "./util.js";

/** About 700 tokens: half a minute for a 7B model on a CPU to read, instead of minutes of paths. */
const BUDGET = 2_800;
/** Where the code usually is, in order of preference. */
const SOURCE_DIRS = ["lib", "src", "app", "source", "pkg", "cmd", "internal", "packages"];

interface Manifest {
  file: string;
  name?: string;
  description?: string;
  deps: string[];
}

/** Name, description and dependencies from the first manifest found. Best effort: no YAML/TOML parser. */
async function readManifest(dir: string): Promise<Manifest | null> {
  const read = (f: string) => fs.readFile(path.join(dir, f), "utf8").catch(() => null);
  const json = (text: string) => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const keys = (v: unknown) => (v && typeof v === "object" ? Object.keys(v) : []);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

  const pubspec = await read("pubspec.yaml");
  if (pubspec !== null) {
    const deps = section(pubspec, /^dependencies:[ \t]*$/m).flatMap((l) => /^ {2}([A-Za-z_]\w*)\s*:/.exec(l)?.[1] ?? []);
    return { file: "pubspec.yaml", name: yamlValue(pubspec, "name"), description: yamlValue(pubspec, "description"), deps: deps.filter((d) => d !== "flutter") };
  }
  const pkg = await read("package.json");
  if (pkg !== null) {
    const j = json(pkg);
    return { file: "package.json", name: str(j.name), description: str(j.description), deps: keys(j.dependencies) };
  }
  const composer = await read("composer.json");
  if (composer !== null) {
    const j = json(composer);
    return { file: "composer.json", name: str(j.name), description: str(j.description), deps: keys(j.require).filter((d) => d !== "php" && !d.startsWith("ext-")) };
  }
  const pyproject = await read("pyproject.toml");
  if (pyproject !== null) {
    const list = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(pyproject)?.[1] ?? "";
    const pep621 = [...list.matchAll(/["']([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
    const poetry = section(pyproject, /^\[tool\.poetry\.dependencies\]/m).flatMap((l) => /^([\w.-]+)\s*=/.exec(l)?.[1] ?? []);
    return { file: "pyproject.toml", name: tomlValue(pyproject, "name"), description: tomlValue(pyproject, "description"), deps: [...pep621, ...poetry].filter((d) => d !== "python") };
  }
  const cargo = await read("Cargo.toml");
  if (cargo !== null) {
    const deps = section(cargo, /^\[dependencies\]/m).flatMap((l) => /^([\w-]+)\s*=/.exec(l)?.[1] ?? []);
    return { file: "Cargo.toml", name: tomlValue(cargo, "name"), description: tomlValue(cargo, "description"), deps };
  }
  const gomod = await read("go.mod");
  if (gomod !== null) {
    const deps = [...gomod.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w./-]+)\s+v\d/gm)].map((m) => m[1].split("/").slice(-2).join("/"));
    return { file: "go.mod", name: /^module\s+(\S+)/m.exec(gomod)?.[1], deps };
  }
  return null;
}

/** The lines of a section: after the heading line, until the next line that starts a new one. */
function section(text: string, heading: RegExp): string[] {
  const m = heading.exec(text);
  if (!m) return [];
  const lines = text.slice(m.index + m[0].length).split("\n").slice(1);
  const end = lines.findIndex((l) => /^\S/.test(l) && !l.startsWith("#"));
  return end < 0 ? lines : lines.slice(0, end);
}

/** A top-level YAML scalar, including a folded (>) or literal (|) block. */
function yamlValue(text: string, key: string): string | undefined {
  const m = new RegExp(String.raw`^${key}:[ \t]*(.*)$`, "m").exec(text);
  if (!m) return undefined;
  let v = m[1].replace(/\s+#.*$/, "").trim();
  if (/^[>|][-+]?$/.test(v) || v === "") v = section(text, new RegExp(String.raw`^${key}:.*$`, "m")).map((l) => l.trim()).filter(Boolean).join(" ");
  return v.replace(/^["']|["']$/g, "").trim() || undefined;
}

function tomlValue(text: string, key: string): string | undefined {
  return new RegExp(String.raw`^${key}\s*=\s*"([^"]*)"`, "m").exec(text)?.[1]?.trim() || undefined;
}

/** The first prose of the README: no title, badges, images or HTML. */
async function readmeText(dir: string): Promise<string | undefined> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const name = entries.find((e) => /^readme(\.(md|markdown|txt|rst))?$/i.test(e));
  if (!name) return undefined;
  const text = (await fs.readFile(path.join(dir, name), "utf8").catch(() => "")).slice(0, 6_000);
  const prose = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(#|!\[|\[!\[|<|```|---|===|\|)/.test(l))
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  if (!prose) return undefined;
  return prose.length <= 400 ? prose : `${prose.slice(0, 400).replace(/\s+\S*$/, "")} …`;
}

/** "(.dart)" or "(.png, .json)": the most common extensions among some files. */
function kinds(files: string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const ext = path.extname(f);
    if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([e]) => e);
  return top.length ? ` (${top.join(", ")})` : "";
}

/** Files grouped by their first path segment ("" for files at the root). */
function byFolder(files: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const i = f.indexOf("/");
    const key = i < 0 ? "" : f.slice(0, i);
    const rest = i < 0 ? f : f.slice(i + 1);
    groups.set(key, [...(groups.get(key) ?? []), rest]);
  }
  return groups;
}

function stackLine(label: string, stack: string[], manifest: Manifest | null): string {
  const what = stack.length ? stack.join(", ") : "no manifest found";
  const about = [manifest?.name && `"${manifest.name}"`, manifest?.description].filter(Boolean).join(": ");
  return `${label} — ${what}${manifest ? ` (${manifest.file})` : ""}${about ? `. ${about}` : ""}`;
}

/** "Flutter (pubspec.yaml). "eq_app": Enjoy the power of hype muzik", or "" for a folder that isn't a project. */
export async function briefDescription(dir: string): Promise<string> {
  const [manifest, project] = await Promise.all([readManifest(dir), detectProject(dir)]);
  if (!manifest && !project.stack.length) return "";
  return stackLine("", project.stack, manifest).replace(/^ — /, "");
}

async function describeProject(dir: string, label: string, signal?: AbortSignal): Promise<string> {
  const [manifest, project, files, readme, commits] = await Promise.all([readManifest(dir), detectProject(dir), listFiles(dir, signal), readmeText(dir), latestCommits(dir, signal)]);
  const lines = [stackLine(label, project.stack, manifest)];
  const commands = Object.entries(project.commands).map(([k, v]) => `${k} \`${v}\``);
  if (commands.length) lines.push(`Commands: ${commands.join(", ")}`);

  const groups = byFolder(files);
  const root = (groups.get("") ?? []).filter((f) => !f.startsWith("."));
  groups.delete("");
  const folders = [...groups].sort((a, b) => b[1].length - a[1].length);
  const shown = folders.slice(0, 12).map(([d, fs]) => `${d}/ ${fs.length}${kinds(fs)}`);
  const more = folders.length > 12 ? `, +${folders.length - 12} more folders` : "";
  lines.push(`Files: ${files.length}, gitignored ones left out. By folder: ${shown.join(", ")}${more}`);

  const source = SOURCE_DIRS.find((d) => groups.has(d));
  if (source) {
    const inner = byFolder(groups.get(source)!);
    const direct = (inner.get("") ?? []).slice(0, 8);
    inner.delete("");
    const subs = [...inner].sort((a, b) => b[1].length - a[1].length).slice(0, 14).map(([d, fs]) => `${d}/ (${fs.length})`);
    lines.push(`${source}/: ${[...direct, ...subs].join(", ")}`);
  }
  if (root.length) lines.push(`Root files: ${root.slice(0, 15).join(", ")}${root.length > 15 ? ", …" : ""}`);
  if (commits) lines.push(`Latest commits, newest first: ${commits}`);
  if (manifest?.deps.length) lines.push(`Dependencies: ${manifest.deps.slice(0, 25).join(", ")}${manifest.deps.length > 25 ? `, +${manifest.deps.length - 25} more` : ""}`);
  if (readme) lines.push(`README: ${readme}`);
  return lines.join("\n");
}

/** The folder's last five commits ("2 days ago: Add the player; …"): where the work stopped. "" outside git. */
async function latestCommits(dir: string, signal?: AbortSignal): Promise<string> {
  const log = await git(["log", "-n", "5", "--no-merges", "--format=%cr: %s", "--", "."], { cwd: dir, signal }, 10_000, true).catch(() => "");
  return log
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => (l.length > 140 ? `${l.slice(0, 140)}…` : l))
    .join("; ");
}

/** A folder holding several projects (no manifest of its own): each one in a line. */
async function describeWorkspace(dir: string, label: string, dirs: string[], files: string[]): Promise<string> {
  const rows = await Promise.all(
    dirs.map(async (d) => {
      const sub = path.join(dir, d);
      const [manifest, project] = await Promise.all([readManifest(sub), detectProject(sub)]);
      if (!manifest && !project.stack.length) return `${d}/`;
      const line = stackLine(`${d}/`, project.stack, manifest);
      return line.length <= 180 ? line : `${line.slice(0, 180).replace(/\s+\S*$/, "")} …`;
    }),
  );
  const head = `${label}: ${dirs.length} folders${files.length ? `, ${files.length} files (${files.slice(0, 6).join(", ")}${files.length > 6 ? ", …" : ""})` : ""}`;
  return [head, ...rows, 'For one of them: project_overview with its path.'].join("\n");
}

function fit(text: string): string {
  if (text.length <= BUDGET) return text;
  const cut = text.slice(0, BUDGET);
  return `${cut.slice(0, cut.lastIndexOf("\n"))}\n[…]`;
}

export const projectOverview: Tool = {
  name: "project_overview",
  label: "Overview",
  description:
    "Get to know a project or folder in one call: stack, name and description, commands, main folders with file counts, the source folder's layout, dependencies and README. For a folder of projects, each project's stack. Gitignored files are left out. Start here before glob or read_file when exploring.",
  parameters: { type: "object", properties: { path: { type: "string", description: "Folder (default: the project root)" } } },
  lean: { description: "Get to know a project or folder in one call: stack, commands, folders, dependencies, README. Start here when exploring." },
  risk: "safe",
  describe: (a) => `overview of ${a.path || "."}`,
  target: (a) => String(a.path || "."),
  activity: (a) => `Looking over ${a.path || "the project"}`,
  summarize(_a, output) {
    return { summary: output.split("\n")[0].slice(0, 120) };
  },
  async run(args, ctx) {
    const rel = typeof args.path === "string" && args.path.trim() ? args.path.trim() : ".";
    const dir = resolveInside(ctx.cwd, rel);
    if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) throw new Error(`not a folder: ${rel}.${didYouMean(await similarPaths(ctx.cwd, rel, "folder"))}`);
    const label = rel === "." ? path.basename(dir) : rel.replace(/\/+$/, "");
    const [manifest, project] = await Promise.all([readManifest(dir), detectProject(dir)]);
    if (!manifest && !project.stack.length) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const visible = entries.filter((e) => !e.name.startsWith(".") && e.name !== "node_modules");
      const dirs = visible.filter((e) => e.isDirectory()).map((e) => e.name).sort();
      const projects = await Promise.all(dirs.map(async (d) => (await readManifest(path.join(dir, d))) !== null));
      if (projects.some(Boolean)) {
        return fit(await describeWorkspace(dir, label, dirs, visible.filter((e) => e.isFile()).map((e) => e.name).sort()));
      }
    }
    return fit(await describeProject(dir, label, ctx.signal));
  },
};
