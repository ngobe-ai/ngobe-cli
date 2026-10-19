import { htmlToText } from "../web/extract.js";
import { http, HttpError, httpJson } from "../web/http.js";
import { fetchPublic } from "../web/net.js";
import {
  compareVersions,
  githubRequest,
  latestVersion,
  resolveTarget,
  versionOf,
  type GithubRelease,
  type LookupContext,
} from "./versions.js";

export interface NotesSection {
  version: string;
  title: string;
  text: string;
  url: string;
}

export interface ReleaseNotes {
  name: string;
  ecosystem: string;
  sections: NotesSection[];
  source: string;
  checkedAt: string;
}

export interface NotesQuery {
  /** Notes for this version (default: the latest). */
  version?: string;
  /** Every release after this version (up to `version` if given): for upgrades and breaking changes. */
  since?: string;
}

/** Changelog files and docs pages for projects whose notes don't live in GitHub releases. */
const NOTES_PAGES: Record<string, (version: string) => string> = {
  flutter: () => "https://raw.githubusercontent.com/flutter/flutter/master/CHANGELOG.md",
  dart: () => "https://raw.githubusercontent.com/dart-lang/sdk/main/CHANGELOG.md",
  python: (v) => `https://docs.python.org/release/${v}/whatsnew/changelog.html`,
  php: (v) => `https://www.php.net/ChangeLog-${v.split(".")[0]}.php`,
  go: () => "https://go.dev/doc/devel/release",
  postgresql: (v) => `https://www.postgresql.org/docs/release/${v}/`,
};

const BREAKING = /breaking|removed|deprecat|no longer|renamed|incompatib|migrat|drop(ped|s)? support/i;

export async function releaseNotes(name: string, ecosystem: string | undefined, q: NotesQuery, ctx: LookupContext = {}): Promise<ReleaseNotes> {
  const target = resolveTarget(name, ecosystem);
  const base = { name: target.pkg, ecosystem: target.ecosystem };

  const page = NOTES_PAGES[target.ecosystem];
  if (page) {
    const version = q.version ?? (await latestVersion(name, ecosystem, ctx)).stable?.version ?? "";
    return { ...base, ...(await fromPage(page(version), { ...q, version }, ctx)) };
  }

  const { repo, changelog } =
    target.ecosystem === "github"
      ? { repo: target.pkg, changelog: null }
      : target.ecosystem === "node"
        ? { repo: "nodejs/node", changelog: null }
        : await links(target.ecosystem, target.pkg, ctx);
  // GitHub releases or CHANGELOG first, then the changelog page the registry links to.
  if (repo) {
    try {
      return { ...base, ...(await fromGithub(repo, q, ctx)) };
    } catch (err) {
      if (!changelog) throw err;
    }
  }
  if (changelog) {
    const version = q.version ?? (q.since ? undefined : (await latestVersion(name, ecosystem, ctx)).stable?.version);
    return { ...base, ...(await fromPage(changelog, { ...q, version }, ctx)) };
  }
  throw new Error(`no source repository or changelog is listed for ${target.pkg}; try web_search for its release notes`);
}

/** Release notes from a changelog file or docs page (markdown or HTML). */
async function fromPage(url: string, q: NotesQuery, ctx: LookupContext): Promise<Omit<ReleaseNotes, "name" | "ecosystem">> {
  // Changelog URLs can come from registry metadata the package publisher controls: public hosts only.
  const res = await fetchPublic(url, { cacheDir: ctx.config?.cacheDir, ttlMs: 60 * 60_000, timeoutMs: 30_000, signal: ctx.signal, maxBytes: 20_000_000 });
  const text = /\.md$|^text\/(plain|markdown)/.test(url) || /markdown|text\/plain/.test(res.headers["content-type"] ?? "") ? res.body : htmlToText(res.body).text;
  return { sections: select(parseSections(text, url), text, url, q), source: url, checkedAt: res.fetchedAt };
}

async function fromGithub(repo: string, q: NotesQuery, ctx: LookupContext): Promise<Omit<ReleaseNotes, "name" | "ecosystem">> {
  const api = `https://api.github.com/repos/${repo}`;
  const opts = githubRequest(ctx);
  const section = (r: GithubRelease): NotesSection => ({
    version: versionOf(r.tag_name),
    title: r.name || r.tag_name,
    text: r.body ?? "",
    url: r.html_url,
  });

  if (q.since) {
    const { data, res } = await httpJson<GithubRelease[]>(`${api}/releases?per_page=50`, opts);
    if (data.length) {
      const sections = data.filter((r) => !r.draft && !r.prerelease).map(section).filter((s) => inRange(s.version, q));
      return { sections, source: `${api}/releases`, checkedAt: res.fetchedAt };
    }
  } else {
    const repoName = repo.split("/")[1];
    const tags = q.version ? [`v${q.version}`, q.version, `${repoName}-v${q.version}`, `${repoName}@${q.version}`] : [null];
    for (const tag of tags) {
      const url = tag ? `${api}/releases/tags/${encodeURIComponent(tag)}` : `${api}/releases/latest`;
      try {
        const { data, res } = await httpJson<GithubRelease>(url, opts);
        return { sections: [section(data)], source: url, checkedAt: res.fetchedAt };
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 404)) throw err;
      }
    }
  }

  // No GitHub releases: read the changelog file instead.
  for (const file of ["CHANGELOG.md", "CHANGES.md", "HISTORY.md"]) {
    const url = `https://raw.githubusercontent.com/${repo}/HEAD/${file}`;
    try {
      const res = await http(url, { cacheDir: ctx.config?.cacheDir, ttlMs: 60 * 60_000, signal: ctx.signal });
      return { sections: select(parseSections(res.body, url), res.body, url, q), source: url, checkedAt: res.fetchedAt };
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
  }
  throw new Error(`${repo} has no GitHub releases${q.version ? ` for ${q.version}` : ""} and no CHANGELOG file`);
}

/** The project's GitHub repository and changelog page, from its registry metadata. */
async function links(ecosystem: string, pkg: string, ctx: LookupContext): Promise<{ repo: string | null; changelog: string | null }> {
  const opts = { cacheDir: ctx.config?.cacheDir, ttlMs: 24 * 3600_000, signal: ctx.signal, maxBytes: 25_000_000 };
  let urls: unknown[] = [];
  let changelog: string | null = null;
  if (ecosystem === "npm") {
    const { data } = await httpJson<{ repository?: { url?: string } | string; homepage?: string }>(
      `https://registry.npmjs.org/${encodeURIComponent(pkg).replace(/^%40/, "@")}/latest`,
      opts,
    );
    urls = [typeof data.repository === "string" ? data.repository : data.repository?.url, data.homepage];
  } else if (ecosystem === "pypi") {
    const { data } = await httpJson<{ info: { project_urls?: Record<string, string>; home_page?: string } }>(`https://pypi.org/pypi/${pkg}/json`, opts);
    const projectUrls = data.info.project_urls ?? {};
    urls = [...Object.values(projectUrls), data.info.home_page];
    changelog = Object.entries(projectUrls).find(([k]) => /change|release|history|news|what.?s new/i.test(k))?.[1] ?? null;
  } else if (ecosystem === "pub") {
    const { data } = await httpJson<{ latest: { pubspec: { repository?: string; homepage?: string } } }>(`https://pub.dev/api/packages/${pkg}`, opts);
    urls = [data.latest.pubspec.repository, data.latest.pubspec.homepage];
    changelog = `https://pub.dev/packages/${pkg}/changelog`;
  } else if (ecosystem === "packagist") {
    const { data } = await httpJson<{ packages: Record<string, { source?: { url?: string } }[]> }>(`https://repo.packagist.org/p2/${pkg}.json`, opts);
    urls = [data.packages[pkg]?.[0]?.source?.url];
  } else if (ecosystem === "crates") {
    const { data } = await httpJson<{ crate: { repository?: string } }>(`https://crates.io/api/v1/crates/${pkg}`, opts);
    urls = [data.crate.repository];
  }
  let repo: string | null = null;
  for (const u of urls) {
    const m = typeof u === "string" ? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(\.git)?(\/|$|#)/.exec(u) : null;
    if (m) {
      repo = `${m[1]}/${m[2]}`;
      break;
    }
  }
  return { repo, changelog };
}

function inRange(version: string, q: NotesQuery): boolean {
  return (!q.since || compareVersions(version, q.since) > 0) && (!q.version || compareVersions(version, q.version) <= 0);
}

/** Split markdown (or extracted HTML) into sections under headings that name a version. */
export function parseSections(text: string, url: string): NotesSection[] {
  const lines = text.split("\n");
  const heads: { i: number; level: number; title: string }[] = [];
  lines.forEach((line, i) => {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) heads.push({ i, level: h[1].length, title: h[2] });
  });
  return heads.flatMap((h, k) => {
    const v = /\d+\.\d+(\.\d+)?([-.](alpha|beta|rc|dev|pre)[\w.]*)?/i.exec(h.title);
    if (!v) return [];
    const end = heads.slice(k + 1).find((n) => n.level <= h.level)?.i ?? lines.length;
    const title = h.title.replace(/[[\]]|\(http[^)]*\)/g, "").trim();
    return [{ version: v[0], title, text: lines.slice(h.i + 1, end).join("\n").trim(), url }];
  });
}

function select(sections: NotesSection[], text: string, url: string, q: NotesQuery): NotesSection[] {
  if (q.since) return sections.filter((s) => inRange(s.version, q));
  if (!q.version) return sections.slice(0, 1);
  const exact = sections.filter((s) => compareVersions(s.version, q.version!) === 0);
  if (exact.length) return exact.slice(0, 1);
  // No heading for it (e.g. point releases described in a paragraph): show the lines around it.
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.includes(q.version!));
  return at < 0 ? [] : [{ version: q.version, title: `mentions of ${q.version}`, text: lines.slice(Math.max(0, at - 3), at + 25).join("\n"), url }];
}

/** Lines that look like breaking changes or removals, per section. */
export function breakingLines(section: NotesSection, max = 15): string[] {
  return section.text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && BREAKING.test(l))
    .slice(0, max);
}
