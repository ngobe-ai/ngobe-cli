/**
 * Authoritative documentation per technology. Defaults only: the config file's "docs" map
 * adds or overrides entries (e.g. {"docs": {"filament": ["filamentphp.com"]}}).
 * Entries are hostnames, or host/path prefixes such as "github.com/flutter".
 */
export const OFFICIAL_DOCS: Record<string, string[]> = {
  flutter: ["docs.flutter.dev", "api.flutter.dev", "github.com/flutter"],
  dart: ["dart.dev", "api.dart.dev", "github.com/dart-lang"],
  laravel: ["laravel.com", "github.com/laravel"],
  php: ["php.net", "github.com/php"],
  node: ["nodejs.org", "github.com/nodejs"],
  typescript: ["typescriptlang.org", "github.com/microsoft/TypeScript"],
  react: ["react.dev", "github.com/facebook/react"],
  nextjs: ["nextjs.org", "github.com/vercel/next.js"],
  python: ["docs.python.org", "peps.python.org", "python.org"],
  docker: ["docs.docker.com", "github.com/docker"],
  postgresql: ["postgresql.org"],
  bun: ["bun.sh", "bun.com", "github.com/oven-sh/bun"],
  go: ["go.dev", "pkg.go.dev"],
  rust: ["doc.rust-lang.org", "rust-lang.org", "docs.rs"],
  vue: ["vuejs.org"],
  svelte: ["svelte.dev"],
  django: ["docs.djangoproject.com"],
  kotlin: ["kotlinlang.org"],
  android: ["developer.android.com"],
  tailwindcss: ["tailwindcss.com"],
  prisma: ["prisma.io"],
  vite: ["vite.dev"],
  llamacpp: ["github.com/ggml-org/llama.cpp"],
  ollama: ["docs.ollama.com", "github.com/ollama"],
};

const ALIASES: Record<string, string> = {
  next: "nextjs",
  "next.js": "nextjs",
  nodejs: "node",
  "node.js": "node",
  postgres: "postgresql",
  ts: "typescript",
  golang: "go",
  py: "python",
  tailwind: "tailwindcss",
  "llama.cpp": "llamacpp",
};

/** Package registries and release metadata hosts the version tools read. */
export const REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "npmjs.com",
  "pypi.org",
  "pub.dev",
  "packagist.org",
  "api.github.com",
  "github.com",
  "raw.githubusercontent.com",
  "osv.dev",
  // Only the release buckets: anyone can host a bucket here and read its access logs.
  "storage.googleapis.com/flutter_infra_release",
  "storage.googleapis.com/dart-archive",
  "go.dev",
  "crates.io",
];

export function normalizeTech(name: string): string {
  const key = name.trim().toLowerCase();
  return ALIASES[key] ?? key;
}

export function docsDomains(tech: string, extra: Record<string, string[]> = {}): string[] {
  const key = normalizeTech(tech);
  return extra[key] ?? OFFICIAL_DOCS[key] ?? [];
}

/** Does the URL fall under a domain entry ("host" or "host/path-prefix"), subdomains included? */
export function urlMatches(raw: string, entry: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const [host, ...rest] = entry.toLowerCase().split("/");
  const prefix = rest.length ? `/${rest.join("/")}` : "";
  const h = url.hostname.toLowerCase();
  const p = url.pathname.toLowerCase();
  // Whole path segments only: github.com/flutter must not cover github.com/flutterx.
  return (h === host || h.endsWith(`.${host}`)) && (!prefix || p === prefix || p.startsWith(`${prefix}/`));
}

/** Is this URL on an official documentation site or package registry? */
export function isOfficialUrl(raw: string, extra: Record<string, string[]> = {}): boolean {
  const entries = [...Object.values(OFFICIAL_DOCS).flat(), ...Object.values(extra).flat(), ...REGISTRY_HOSTS];
  return entries.some((e) => urlMatches(raw, e));
}

/** Technologies mentioned in a query (by key or alias), for ranking official results first. */
export function techsIn(text: string, extra: Record<string, string[]> = {}): string[] {
  const words = text.toLowerCase().match(/[a-z0-9.+#-]+/g) ?? [];
  const known = new Set([...Object.keys(OFFICIAL_DOCS), ...Object.keys(extra)]);
  return [...new Set(words.map(normalizeTech).filter((w) => known.has(w)))];
}
