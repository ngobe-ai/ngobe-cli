import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "./log.js";

/**
 * Ngobe's memory across sessions and projects, kept up to date as it works:
 *
 * - NGOBE.md (next to config.json): markdown the user can read and edit. "About you" holds what the
 *   user asked it to remember, "Lessons" the tool calls that failed and what fixed them, "Projects"
 *   each project worked on: what it is and a dated log of what was done there. Sections the user
 *   adds are kept as they are.
 * - A record of the latest work per folder (stateDir/projects/*.json), saved after every tool call,
 *   so "where did we stop?" or "continue" in a new session can pick up after a crash or a dropped
 *   connection. It is saved for the folder ngobe runs in and for each project the work touched.
 *
 * Everything written passes through redact(); a note to remember that holds a secret is refused.
 */

const MANIFESTS = ["pubspec.yaml", "package.json", "composer.json", "pyproject.toml", "Cargo.toml", "go.mod", "setup.py", "requirements.txt", "Gemfile", "pom.xml", "build.gradle"];
const MAX_ENTRIES = 15;
const MAX_NOTES = 30;
/** About 500 tokens of the session context. */
const CONTEXT_BUDGET = 2_000;

/** What a run did, saved as it goes. */
export interface WorkRecord {
  cwd: string;
  request: string;
  started: string;
  updated: string;
  /** "running" until the run ends (and still "running" if ngobe never got to finish it). */
  outcome: string;
  /** "Edit(lib/main.dart) ok", the newest 40. */
  steps: string[];
  /** Changed files, relative to cwd. */
  files: string[];
  reply?: string;
  error?: string;
}

interface Project {
  dir: string;
  name: string;
  about: string;
  log: string[];
}

interface Doc {
  about: string[];
  lessons: Map<string, string>;
  projects: Project[];
  /** Sections the user added, verbatim. */
  other: string[];
}

const INTRO = "# NGOBE.md\n\nNgobe's memory. It reads this at the start of every session and keeps it up to date as it works; you can edit it.\n";

export class ProjectMemory {
  constructor(
    readonly file: string,
    private readonly stateDir: string,
  ) {}

  /** "remember that …", "always …", "I prefer …": kept in About you. Secrets are never kept. */
  noteAboutUser(text: string): void {
    const note = oneLine(text);
    if (!note || redact(note) !== note) return;
    this.update((doc) => {
      if (doc.about.some((a) => a.toLowerCase() === note.toLowerCase())) return false;
      doc.about = [...doc.about, note].slice(-MAX_NOTES);
      return true;
    });
  }

  /** How a tool call that failed was fixed; the newest per tool. */
  lesson(tool: string, text: string): void {
    this.update((doc) => {
      doc.lessons.delete(tool);
      doc.lessons.set(tool, oneLine(redact(text)).slice(0, 300));
      while (doc.lessons.size > MAX_NOTES) doc.lessons.delete(doc.lessons.keys().next().value!);
      return true;
    });
  }

  /** Add a dated entry to a project's log (the project moves to the top). `about` fills in what the project is, once. */
  logWork(dir: string, entry: string, about?: string): void {
    const abs = path.resolve(dir);
    this.update((doc) => {
      let p = doc.projects.find((x) => x.dir === abs);
      if (!p) p = { dir: abs, name: path.basename(abs), about: "", log: [] };
      if (!p.about && about) p.about = oneLine(redact(about));
      p.log = [...p.log, `${stamp(new Date())} · ${oneLine(redact(entry))}`].slice(-MAX_ENTRIES);
      doc.projects = [p, ...doc.projects.filter((x) => x !== p)];
      return true;
    });
  }

  /** The part of NGOBE.md that matters in cwd, for the session context ("" when there is none). */
  contextFor(cwd: string): string {
    const doc = this.read();
    if (!doc) return "";
    const here = path.resolve(cwd);
    const lines: string[] = [];
    if (doc.about.length) lines.push("About the user:", ...doc.about.slice(-10).map((a) => `- ${a}`));
    if (doc.lessons.size) lines.push("Lessons from earlier mistakes:", ...[...doc.lessons].slice(-10).map(([k, v]) => `- ${k}: ${v}`));
    // The project cwd is in (the deepest one), and the projects inside cwd (a folder of projects).
    const current = doc.projects.filter((p) => isWithin(p.dir, here)).sort((a, b) => b.dir.length - a.dir.length)[0];
    const inside = doc.projects.filter((p) => p !== current && isWithin(here, p.dir));
    if (current) lines.push(`This project, ${current.name}${current.about ? `: ${current.about}` : ""}`, ...current.log.slice(-6).map((l) => `- ${l}`));
    if (inside.length) {
      lines.push("Projects worked on in this folder:");
      for (const p of inside.slice(0, 6)) lines.push(`- ${path.relative(here, p.dir)}/${p.about ? ` (${p.about.slice(0, 80)})` : ""}, last: ${p.log.at(-1) ?? "nothing logged"}`);
    }
    const others = doc.projects.filter((p) => p !== current && !inside.includes(p)).slice(0, 5);
    if (others.length) lines.push(`Other projects: ${others.map((p) => `${p.name} (${tilde(p.dir)})`).join(", ")}`);
    const text = lines.join("\n");
    return text.length <= CONTEXT_BUDGET ? text : `${text.slice(0, CONTEXT_BUDGET).replace(/\n[^\n]*$/, "")}\n…`;
  }

  /** Save the record of the work in progress for each of these folders. */
  saveWork(record: WorkRecord, dirs: string[]): void {
    const clean: WorkRecord = { ...record, request: redact(record.request), reply: record.reply && redact(record.reply), error: record.error && redact(record.error), steps: record.steps.map(redact) };
    for (const dir of new Set(dirs.map((d) => path.resolve(d)))) writeAtomic(this.recordFile(dir), JSON.stringify(clean, null, 2));
  }

  /** The latest work recorded for dir or the nearest folder above it. */
  lastWork(dir: string): WorkRecord | null {
    for (let d = path.resolve(dir); ; d = path.dirname(d)) {
      try {
        return JSON.parse(fs.readFileSync(this.recordFile(d), "utf8")) as WorkRecord;
      } catch {
        if (path.dirname(d) === d) return null;
      }
    }
  }

  private recordFile(dir: string): string {
    return path.join(this.stateDir, "projects", `${crypto.createHash("sha1").update(dir).digest("hex").slice(0, 16)}.json`);
  }

  private read(): Doc | null {
    try {
      return parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return null;
    }
  }

  /** Read, change, write: read right before writing, so another session's changes are kept. */
  private update(change: (doc: Doc) => boolean): void {
    const doc = this.read() ?? { about: [], lessons: new Map(), projects: [], other: [] };
    if (change(doc)) writeAtomic(this.file, render(doc));
  }
}

/** The folder a file or folder belongs to: the nearest one up with .git or a manifest, else the folder itself. */
export function projectRootOf(target: string): string {
  const start = fs.statSync(target, { throwIfNoEntry: false })?.isDirectory() ? target : path.dirname(target);
  for (let d = path.resolve(start); ; d = path.dirname(d)) {
    if ([".git", ...MANIFESTS].some((m) => fs.existsSync(path.join(d, m)))) return d;
    if (path.dirname(d) === d) return path.resolve(start);
  }
}

const RESUME =
  /^(?:(?:ok(?:ay)?|so|please|alright|now|hi|hey)[,!.]?\s+)*(?:let'?s\s+)?(?:continue|resume|carry on|keep going|go on|proceed|pick up where (?:we|you|i) left off|where (?:did|do) we (?:stop|leave off)|where were we|what were (?:we|you) (?:doing|working on)|what was i (?:doing|working on))(?:\s+(?:please|from where (?:we|you) (?:stopped|left off)|where (?:we|you) (?:stopped|left off)|(?:with )?the (?:work|task)))?[\s.!?]*$/i;

/** "continue", "where did we stop?", "pick up where we left off" (alone, not "continue the loop until …"). */
export function isResumeRequest(text: string): boolean {
  return RESUME.test(text.trim());
}

/** What to keep from "remember that X" / "always …" / "I prefer …", or null. */
export function userNote(text: string): string | null {
  const t = text.trim();
  if (t.length > 300 || /^never\s*mind\b/i.test(t)) return null;
  const m = /^(?:please\s+)?remember(?:\s+that)?[:,]?\s+(.+)$/is.exec(t);
  if (m) return oneLine(m[1]);
  return /^(?:from now on|always|never|i (?:prefer|like|use|always|never|want you to)|my name is|call me)\b/i.test(t) ? oneLine(t) : null;
}

/** The record, worded for the model, for "where did we stop?" in a new session. */
export function resumeNote(r: WorkRecord): string {
  const state =
    {
      running: "it stopped before finishing (ngobe was closed or lost its connection)",
      completed: "it was completed",
      cancelled: "the user interrupted it",
      error: `it stopped with an error${r.error ? `: ${r.error}` : ""}`,
      limit: "it hit a limit before finishing",
      declined: "the user declined one of its actions",
    }[r.outcome] ?? r.outcome;
  const parts = [`Ngobe's record of the last work here (${stamp(new Date(r.updated))}): the request was "${r.request}", and ${state}.`];
  if (r.steps.length) parts.push(`Steps: ${r.steps.slice(-12).join("; ")}.`);
  if (r.files.length) parts.push(`Files changed: ${r.files.join(", ")}.`);
  if (r.reply) parts.push(`Last reply: "${r.reply.slice(0, 300)}".`);
  parts.push(r.outcome === "completed" ? "Say where we stopped and what could come next." : "Continue that work from where it stopped; don't redo the finished steps.");
  return `[${parts.join(" ")}]`;
}

function parse(text: string): Doc {
  const doc: Doc = { about: [], lessons: new Map(), projects: [], other: [] };
  let section: "about" | "lessons" | "projects" | "other" | null = null;
  let project: Project | null = null;
  for (const line of text.split("\n")) {
    const h2 = /^## (.+)$/.exec(line);
    if (h2) {
      const title = h2[1].trim().toLowerCase();
      section = title === "about you" ? "about" : title === "lessons" ? "lessons" : title === "projects" ? "projects" : "other";
      project = null;
      if (section === "other") doc.other.push(line);
      continue;
    }
    if (section === null) continue; // the title and intro are written fresh
    if (section === "other") {
      doc.other.push(line);
      continue;
    }
    const bullet = /^- (.+)$/.exec(line)?.[1];
    if (section === "about") {
      if (bullet) doc.about.push(bullet);
    } else if (section === "lessons") {
      const m = bullet && /^([\w.-]+): (.+)$/.exec(bullet);
      if (m) doc.lessons.set(m[1], m[2]);
    } else {
      const h3 = /^### (.+?) · (.+)$/.exec(line);
      if (h3) {
        project = { name: h3[1].trim(), dir: untilde(h3[2].trim()), about: "", log: [] };
        doc.projects.push(project);
      } else if (project && bullet) project.log.push(bullet);
      else if (project && line.trim() && !project.about) project.about = line.trim();
    }
  }
  return doc;
}

function render(doc: Doc): string {
  const out = [INTRO, "## About you\n", ...doc.about.map((a) => `- ${a}`), "", "## Lessons\n", ...[...doc.lessons].map(([k, v]) => `- ${k}: ${v}`), "", "## Projects\n"];
  for (const p of doc.projects) out.push(`### ${p.name} · ${tilde(p.dir)}\n`, ...(p.about ? [p.about, ""] : []), ...p.log.map((l) => `- ${l}`), "");
  if (doc.other.length) out.push(doc.other.join("\n").trim(), "");
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function tilde(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function untilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}

/** True when inner is outer or inside it. */
function isWithin(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
