import type { Config } from "../config.js";
import { HttpError, httpJson, type HttpOptions } from "../web/http.js";

export interface Release {
  version: string;
  /** stable, latest, current, lts (Krypton), beta, next, … */
  channel: string;
  date?: string;
  url?: string;
}

export interface LatestInfo {
  /** The package as looked up, e.g. "laravel/framework" for "laravel". */
  name: string;
  ecosystem: string;
  stable: Release | null;
  /** Newer pre-releases and other channels (beta, LTS, dist-tags). */
  other: Release[];
  /** The official endpoint the answer came from. */
  source: string;
  /** When that endpoint was last fetched (a cached answer keeps its original time). */
  checkedAt: string;
  note?: string;
}

export interface LookupContext {
  config?: Config;
  signal?: AbortSignal;
}

export const ECOSYSTEMS = [
  "flutter",
  "dart",
  "node",
  "python",
  "php",
  "go",
  "postgresql",
  "npm",
  "pypi",
  "pub",
  "packagist",
  "crates",
  "github",
] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

const ECOSYSTEM_ALIASES: Record<string, Ecosystem> = {
  pip: "pypi",
  composer: "packagist",
  cargo: "crates",
  "crates.io": "crates",
  gh: "github",
  nodejs: "node",
  "node.js": "node",
  golang: "go",
  postgres: "postgresql",
};

/** Well-known names → where their releases are published. */
const KNOWN: Record<string, { ecosystem: Ecosystem; pkg?: string }> = {
  flutter: { ecosystem: "flutter" },
  dart: { ecosystem: "dart" },
  node: { ecosystem: "node" },
  nodejs: { ecosystem: "node" },
  "node.js": { ecosystem: "node" },
  python: { ecosystem: "python" },
  php: { ecosystem: "php" },
  go: { ecosystem: "go" },
  golang: { ecosystem: "go" },
  postgresql: { ecosystem: "postgresql" },
  postgres: { ecosystem: "postgresql" },
  rust: { ecosystem: "github", pkg: "rust-lang/rust" },
  bun: { ecosystem: "github", pkg: "oven-sh/bun" },
  deno: { ecosystem: "github", pkg: "denoland/deno" },
  ollama: { ecosystem: "github", pkg: "ollama/ollama" },
  "llama.cpp": { ecosystem: "github", pkg: "ggml-org/llama.cpp" },
  kotlin: { ecosystem: "github", pkg: "JetBrains/kotlin" },
  laravel: { ecosystem: "packagist", pkg: "laravel/framework" },
  symfony: { ecosystem: "packagist", pkg: "symfony/symfony" },
  react: { ecosystem: "npm", pkg: "react" },
  next: { ecosystem: "npm", pkg: "next" },
  nextjs: { ecosystem: "npm", pkg: "next" },
  "next.js": { ecosystem: "npm", pkg: "next" },
  typescript: { ecosystem: "npm", pkg: "typescript" },
  vue: { ecosystem: "npm", pkg: "vue" },
  angular: { ecosystem: "npm", pkg: "@angular/core" },
  svelte: { ecosystem: "npm", pkg: "svelte" },
  vite: { ecosystem: "npm", pkg: "vite" },
  express: { ecosystem: "npm", pkg: "express" },
  tailwind: { ecosystem: "npm", pkg: "tailwindcss" },
  tailwindcss: { ecosystem: "npm", pkg: "tailwindcss" },
  prisma: { ecosystem: "npm", pkg: "prisma" },
  npm: { ecosystem: "npm", pkg: "npm" },
  pnpm: { ecosystem: "npm", pkg: "pnpm" },
  django: { ecosystem: "pypi", pkg: "django" },
  flask: { ecosystem: "pypi", pkg: "flask" },
  fastapi: { ecosystem: "pypi", pkg: "fastapi" },
};

/** Work out which registry or release source a name refers to. */
export function resolveTarget(name: string, ecosystem?: string): { ecosystem: Ecosystem; pkg: string } {
  const n = name.trim();
  if (ecosystem) {
    const e = (ECOSYSTEM_ALIASES[ecosystem.toLowerCase()] ?? ecosystem.toLowerCase()) as Ecosystem;
    if (!ECOSYSTEMS.includes(e)) throw new Error(`unknown ecosystem "${ecosystem}". Use one of: ${ECOSYSTEMS.join(", ")}`);
    const known = KNOWN[n.toLowerCase()];
    return { ecosystem: e, pkg: known?.ecosystem === e && known.pkg ? known.pkg : n };
  }
  const known = KNOWN[n.toLowerCase()];
  if (known) return { ecosystem: known.ecosystem, pkg: known.pkg ?? n.toLowerCase() };
  if (n.startsWith("@")) return { ecosystem: "npm", pkg: n };
  throw new Error(
    `can't tell where "${n}" is published. Pass an ecosystem: npm, pypi, pub, packagist (vendor/name), crates, github (owner/repo), or one of flutter, dart, node, python, php, go, postgresql.`,
  );
}

/** Latest stable release (and newer pre-release channels) from the official source. */
export async function latestVersion(name: string, ecosystem: string | undefined, ctx: LookupContext = {}): Promise<LatestInfo> {
  const target = resolveTarget(name, ecosystem);
  try {
    const info = await RESOLVERS[target.ecosystem](target.pkg, ctx);
    return { name: target.pkg, ecosystem: target.ecosystem, ...info };
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new Error(`${target.pkg} was not found in ${target.ecosystem} (${err.url})`);
    }
    if (err instanceof HttpError && err.status === 403 && err.url.includes("api.github.com")) {
      throw new Error("GitHub API rate limit reached (60 requests/hour without a token). Set GITHUB_TOKEN to raise it.");
    }
    throw err;
  }
}

type Resolved = Omit<LatestInfo, "name" | "ecosystem">;

function req(ctx: LookupContext, ttlMs = 10 * 60_000, timeoutMs = 20_000): HttpOptions {
  return { cacheDir: ctx.config?.cacheDir, ttlMs, timeoutMs, signal: ctx.signal, maxBytes: 25_000_000 };
}

const day = (d: string | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : undefined);

const RESOLVERS: Record<Ecosystem, (pkg: string, ctx: LookupContext) => Promise<Resolved>> = {
  async flutter(_pkg, ctx) {
    const url = "https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json";
    const { data, res } = await httpJson<{
      current_release: Record<string, string>;
      releases: { hash: string; channel: string; version: string; release_date: string }[];
    }>(url, req(ctx));
    const pick = (channel: string): Release | null => {
      const hash = data.current_release[channel];
      const r = data.releases.find((x) => x.hash === hash && x.channel === channel) ?? data.releases.find((x) => x.hash === hash);
      return r ? { version: r.version, channel, date: day(r.release_date) } : null;
    };
    return { stable: pick("stable"), other: [pick("beta")].filter((r): r is Release => !!r), source: url, checkedAt: res.fetchedAt };
  },

  async dart(_pkg, ctx) {
    const channel = async (ch: string) => {
      const url = `https://storage.googleapis.com/dart-archive/channels/${ch}/release/latest/VERSION`;
      const { data, res } = await httpJson<{ version: string; date: string }>(url, req(ctx));
      return { release: { version: data.version, channel: ch, date: day(data.date) }, url, res };
    };
    const [stable, beta, dev] = await Promise.allSettled([channel("stable"), channel("beta"), channel("dev")]);
    if (stable.status === "rejected") throw stable.reason;
    const other = [beta, dev].flatMap((r) => (r.status === "fulfilled" ? [r.value.release] : []));
    return { stable: stable.value.release, other, source: stable.value.url, checkedAt: stable.value.res.fetchedAt };
  },

  async node(_pkg, ctx) {
    const url = "https://nodejs.org/dist/index.json";
    const { data, res } = await httpJson<{ version: string; date: string; lts: string | false }[]>(url, req(ctx));
    const current = data[0];
    const lts = data.find((r) => r.lts);
    return {
      stable: current ? { version: current.version.replace(/^v/, ""), channel: "current", date: current.date } : null,
      other: lts ? [{ version: lts.version.replace(/^v/, ""), channel: `lts (${lts.lts})`, date: lts.date }] : [],
      source: url,
      checkedAt: res.fetchedAt,
      note: "Current is the newest release line; LTS is the one recommended for production.",
    };
  },

  async python(_pkg, ctx) {
    // Slow endpoint (10s+), so cache longer.
    const url = "https://www.python.org/api/v2/downloads/release/?is_published=true&pre_release=false";
    const { data, res } = await httpJson<{ name: string; release_date: string }[]>(url, req(ctx, 6 * 3600_000, 45_000));
    const releases = data
      .map((r) => ({ version: /^Python (\d+\.\d+\.\d+)$/.exec(r.name)?.[1], date: day(r.release_date) }))
      .filter((r): r is { version: string; date: string | undefined } => !!r.version)
      .sort((a, b) => compareVersions(b.version, a.version));
    return { stable: releases[0] ? { ...releases[0], channel: "stable" } : null, other: [], source: url, checkedAt: res.fetchedAt };
  },

  async php(_pkg, ctx) {
    const url = "https://www.php.net/releases/?json";
    const { data, res } = await httpJson<Record<string, { version: string; date?: string }>>(url, req(ctx));
    const newest = Object.values(data).sort((a, b) => compareVersions(b.version, a.version))[0];
    return {
      stable: newest ? { version: newest.version, channel: "stable", date: newest.date ? day(newest.date) : undefined } : null,
      other: [],
      source: url,
      checkedAt: res.fetchedAt,
    };
  },

  async go(_pkg, ctx) {
    const url = "https://go.dev/dl/?mode=json";
    const { data, res } = await httpJson<{ version: string; stable: boolean }[]>(url, req(ctx));
    const stable = data.find((r) => r.stable);
    return { stable: stable ? { version: stable.version.replace(/^go/, ""), channel: "stable" } : null, other: [], source: url, checkedAt: res.fetchedAt };
  },

  async postgresql(_pkg, ctx) {
    const url = "https://www.postgresql.org/versions.json";
    const { data, res } = await httpJson<{ major: string; latestMinor: string; current: boolean; relDate: string }[]>(
      url,
      req(ctx, 6 * 3600_000, 30_000),
    );
    const cur = data.find((r) => r.current);
    return {
      stable: cur ? { version: `${cur.major}.${cur.latestMinor}`, channel: "stable", date: cur.relDate } : null,
      other: [],
      source: url,
      checkedAt: res.fetchedAt,
    };
  },

  async npm(pkg, ctx) {
    const url = `https://registry.npmjs.org/-/package/${encodeURIComponent(pkg).replace(/^%40/, "@")}/dist-tags`;
    const { data, res } = await httpJson<Record<string, string>>(url, req(ctx));
    const other = Object.entries(data)
      .filter(([tag, v]) => tag !== "latest" && v !== data.latest && compareVersions(v, data.latest ?? "0") > 0)
      .map(([tag, v]) => ({ version: v, channel: tag }));
    return {
      stable: data.latest ? { version: data.latest, channel: "latest" } : null,
      other,
      source: url,
      checkedAt: res.fetchedAt,
      note: "npm dist-tags carry no release dates.",
    };
  },

  async pypi(pkg, ctx) {
    const url = `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`;
    const { data, res } = await httpJson<{ info: { version: string }; releases: Record<string, { upload_time_iso_8601: string }[]> }>(url, req(ctx));
    const uploaded = (v: string) => data.releases[v]?.[0]?.upload_time_iso_8601;
    const stable = data.info.version;
    const pre = Object.keys(data.releases)
      .filter((v) => isPrerelease(v) && data.releases[v].length && compareVersions(v, stable) > 0)
      .sort((a, b) => compareVersions(b, a))[0];
    return {
      stable: { version: stable, channel: isPrerelease(stable) ? "pre-release" : "stable", date: day(uploaded(stable)) },
      other: pre ? [{ version: pre, channel: "pre-release", date: day(uploaded(pre)) }] : [],
      source: url,
      checkedAt: res.fetchedAt,
    };
  },

  async pub(pkg, ctx) {
    const url = `https://pub.dev/api/packages/${encodeURIComponent(pkg)}`;
    const { data, res } = await httpJson<{ latest: { version: string; published: string }; versions: { version: string; published: string }[] }>(
      url,
      req(ctx),
    );
    const pre = data.versions
      .filter((v) => isPrerelease(v.version) && compareVersions(v.version, data.latest.version) > 0)
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    return {
      stable: { version: data.latest.version, channel: "stable", date: day(data.latest.published) },
      other: pre ? [{ version: pre.version, channel: "pre-release", date: day(pre.published) }] : [],
      source: url,
      checkedAt: res.fetchedAt,
    };
  },

  async packagist(pkg, ctx) {
    if (!pkg.includes("/")) throw new Error(`packagist packages are named vendor/name (got "${pkg}")`);
    const url = `https://repo.packagist.org/p2/${pkg.toLowerCase()}.json`;
    const { data, res } = await httpJson<{ packages: Record<string, { version: string; time?: string }[]> }>(url, req(ctx));
    const list = [...(data.packages[pkg.toLowerCase()] ?? [])].sort((a, b) => compareVersions(b.version, a.version));
    const stable = list.find((v) => !isPrerelease(v.version));
    const pre = list.find((v) => isPrerelease(v.version) && (!stable || compareVersions(v.version, stable.version) > 0));
    const rel = (v: { version: string; time?: string }, channel: string) => ({ version: v.version.replace(/^v/, ""), channel, date: day(v.time) });
    return { stable: stable ? rel(stable, "stable") : null, other: pre ? [rel(pre, "pre-release")] : [], source: url, checkedAt: res.fetchedAt };
  },

  async crates(pkg, ctx) {
    const url = `https://crates.io/api/v1/crates/${encodeURIComponent(pkg)}`;
    const { data, res } = await httpJson<{
      crate: { max_stable_version: string | null; max_version: string };
      versions: { num: string; created_at: string }[];
    }>(url, req(ctx));
    const created = (v: string) => day(data.versions.find((x) => x.num === v)?.created_at);
    const stable = data.crate.max_stable_version;
    const max = data.crate.max_version;
    return {
      stable: stable ? { version: stable, channel: "stable", date: created(stable) } : null,
      other: max && max !== stable ? [{ version: max, channel: "pre-release", date: created(max) }] : [],
      source: url,
      checkedAt: res.fetchedAt,
    };
  },

  async github(pkg, ctx) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(pkg)) throw new Error(`github projects are named owner/repo (got "${pkg}")`);
    const api = `https://api.github.com/repos/${pkg}`;
    const opts = githubRequest(ctx);
    try {
      const { data, res } = await httpJson<GithubRelease>(`${api}/releases/latest`, opts);
      const stable = fromRelease(data, "stable");
      const recent = await httpJson<GithubRelease[]>(`${api}/releases?per_page=10`, opts).catch(() => null);
      const pre = recent?.data.find((r) => r.prerelease && !r.draft && compareVersions(versionOf(r.tag_name), stable.version) > 0);
      return { stable, other: pre ? [fromRelease(pre, "pre-release")] : [], source: `${api}/releases/latest`, checkedAt: res.fetchedAt };
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) throw err;
    }
    // No formal releases: fall back to the highest version-like tag (tags carry no dates).
    const { data, res } = await httpJson<{ name: string }[]>(`${api}/tags?per_page=100`, opts);
    const tags = data.map((t) => ({ tag: t.name, version: versionOf(t.name) })).filter((t) => /\d/.test(t.version));
    const stable = tags.filter((t) => !isPrerelease(t.version)).sort((a, b) => compareVersions(b.version, a.version))[0];
    return {
      stable: stable ? { version: stable.version, channel: `tag ${stable.tag}`, url: `https://github.com/${pkg}/releases/tag/${stable.tag}` } : null,
      other: [],
      source: `${api}/tags`,
      checkedAt: res.fetchedAt,
      note: "This project publishes tags but no GitHub releases.",
    };
  },
};

export interface GithubRelease {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  html_url: string;
  prerelease: boolean;
  draft: boolean;
  body?: string | null;
}

export function githubRequest(ctx: LookupContext): HttpOptions {
  const token = ctx.config?.githubToken;
  return {
    ...req(ctx),
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
}

function fromRelease(r: GithubRelease, channel: string): Release {
  return { version: versionOf(r.tag_name), channel, date: day(r.published_at ?? undefined), url: r.html_url };
}

/** "bun-v1.4.3" → "1.4.3", "v2.0.0-rc.1" → "2.0.0-rc.1"; tags without a number are returned as-is. */
export function versionOf(tag: string): string {
  return /\d+(\.\d+)+(-[\w.]+)?/.exec(tag)?.[0] ?? /\d+/.exec(tag)?.[0] ?? tag;
}

export function isPrerelease(version: string): boolean {
  const v = version.replace(/\+.*$/, "").replace(/^v/i, "");
  return /-|alpha|beta|rc|dev|pre|preview|canary|next|nightly|snapshot|\d[ab]\d/i.test(v);
}

/**
 * Compare version strings: numeric parts first (missing parts count as 0), then a release
 * sorts after its own pre-releases. Prefixes like "v" or "go" and build metadata are ignored.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /(\d+(?:\.\d+)*)(.*)$/.exec(v.replace(/\+.*$/, ""));
    return { nums: m ? m[1].split(".").map(Number) : [], pre: m ? m[2].replace(/^[-.]/, "") : v };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre, undefined, { numeric: true });
}
