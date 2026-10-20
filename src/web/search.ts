import type { Config, SearchProvider } from "../config.js";
import { decode } from "./extract.js";
import { httpJson } from "./http.js";
import { docsDomains, isOfficialUrl, techsIn, urlMatches } from "./sources.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
  official: boolean;
}

export interface SearchResponse {
  provider: SearchProvider;
  query: string;
  results: SearchResult[];
  fetchedAt: string;
  /** Providers that failed before this one answered. */
  failures: string[];
}

export interface SearchOptions {
  count?: number;
  /** Restrict to these sites (hostnames). */
  sites?: string[];
  signal?: AbortSignal;
}

type Raw = Omit<SearchResult, "official">;

const TTL = 60 * 60_000; // identical searches within an hour are served from cache

/**
 * Search the web with the configured providers in order, moving to the next only when
 * one fails or returns nothing. Official documentation and registries rank first.
 */
export async function webSearch(config: Config, query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
  if (config.searchProviders.length === 0) {
    throw new Error(
      "No web search provider is configured. Set BRAVE_API_KEY, TAVILY_API_KEY or NGOBE_SEARXNG_URL (see `ngobe doctor`).",
    );
  }
  const count = Math.min(Math.max(opts.count ?? 8, 1), 20);
  const failures: string[] = [];
  for (const provider of config.searchProviders) {
    try {
      const raw = await PROVIDERS[provider](config, query, count, opts);
      if (raw.length === 0) {
        failures.push(`${provider}: no results`);
        continue;
      }
      return { provider, query, results: rank(raw, query, config), fetchedAt: new Date().toISOString(), failures };
    } catch (err) {
      failures.push(`${provider}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Web search failed. ${failures.join("; ")}`);
}

/** Search one technology's official documentation sites. */
export function searchDocs(config: Config, tech: string, query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
  const sites = docsDomains(tech, config.docs).map((d) => d.split("/")[0]);
  if (sites.length === 0) {
    throw new Error(`No official documentation sites are known for "${tech}". Add them under "docs" in the config file.`);
  }
  return webSearch(config, `${tech} ${query}`, { ...opts, sites: [...new Set(sites)] });
}

function siteQuery(query: string, sites?: string[]): string {
  if (!sites?.length) return query;
  return `${query} (${sites.map((s) => `site:${s}`).join(" OR ")})`;
}

const clean = (s: unknown) => decode(String(s ?? "").replace(/<[^>]+>/g, "")).trim();

const PROVIDERS: Record<SearchProvider, (c: Config, q: string, n: number, o: SearchOptions) => Promise<Raw[]>> = {
  async brave(config, query, count, opts) {
    if (!config.braveApiKey) throw new Error("BRAVE_API_KEY is not set");
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(siteQuery(query, opts.sites))}&count=${count}`;
    const { data } = await httpJson<{ web?: { results?: { title: string; url: string; description?: string; page_age?: string; age?: string }[] } }>(url, {
      headers: { "x-subscription-token": config.braveApiKey },
      cacheDir: config.cacheDir,
      ttlMs: TTL,
      signal: opts.signal,
    });
    return (data.web?.results ?? []).map((r) => ({
      title: clean(r.title),
      url: r.url,
      snippet: clean(r.description),
      published: r.page_age ?? r.age,
    }));
  },

  async tavily(config, query, count, opts) {
    if (!config.tavilyApiKey) throw new Error("TAVILY_API_KEY is not set");
    const { data } = await httpJson<{ results?: { title: string; url: string; content?: string; published_date?: string }[] }>(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: { authorization: `Bearer ${config.tavilyApiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ query, max_results: count, include_domains: opts.sites ?? [] }),
        cacheDir: config.cacheDir,
        ttlMs: TTL,
        signal: opts.signal,
      },
    );
    return (data.results ?? []).map((r) => ({ title: clean(r.title), url: r.url, snippet: clean(r.content).slice(0, 400), published: r.published_date }));
  },

  async searxng(config, query, count, opts) {
    if (!config.searxngURL) throw new Error("NGOBE_SEARXNG_URL is not set");
    const base = config.searxngURL.replace(/\/+$/, "");
    const url = `${base}/search?q=${encodeURIComponent(siteQuery(query, opts.sites))}&format=json`;
    const { data } = await httpJson<{ results?: { title: string; url: string; content?: string; publishedDate?: string }[] }>(url, {
      cacheDir: config.cacheDir,
      ttlMs: TTL,
      signal: opts.signal,
      headers: config.searxngKey ? { authorization: `Bearer ${config.searxngKey}` } : undefined,
    });
    return (data.results ?? []).slice(0, count).map((r) => ({ title: clean(r.title), url: r.url, snippet: clean(r.content), published: r.publishedDate }));
  },
};

/** Dedupe, then put official sources first (the query's own technologies before any other). */
function rank(raw: Raw[], query: string, config: Config): SearchResult[] {
  const seen = new Set<string>();
  const own = techsIn(query, config.docs).flatMap((t) => docsDomains(t, config.docs));
  const score = (r: SearchResult) => (own.some((d) => urlMatches(r.url, d)) ? 2 : r.official ? 1 : 0);
  return raw
    .filter((r) => {
      const key = r.url.replace(/[#?].*$/, "").replace(/\/$/, "");
      if (!r.url || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((r) => ({ ...r, official: isOfficialUrl(r.url, config.docs) }))
    .map((r, i) => ({ r, i, s: score(r) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ r }) => r);
}
