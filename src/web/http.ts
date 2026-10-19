import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { VERSION } from "../config.js";

export const USER_AGENT = `ngobe/${VERSION} (+https://github.com/ngobe-ai/ngobe-cli)`;

export interface HttpResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  /** When the body was fetched from the origin (a cache hit keeps the original time). */
  fetchedAt: string;
  fromCache: boolean;
}

export interface HttpOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Serve from the disk cache when younger than this; 0 = always revalidate (still conditional). */
  ttlMs?: number;
  /** Where to cache 200 responses; no caching without it. */
  cacheDir?: string;
  retries?: number;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
  }
}

interface CacheEntry {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  fetchedAt: string;
}

const KEEP_HEADERS = ["content-type", "etag", "last-modified", "location"];

/**
 * fetch with a timeout, a size limit, retries with backoff for network errors, 429 and 5xx
 * (honoring Retry-After), and an on-disk cache revalidated with ETag / Last-Modified.
 * Non-2xx responses (other than redirects in manual mode) throw HttpError.
 */
export async function http(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
  const method = opts.method ?? "GET";
  const key = crypto.createHash("sha256").update(`${method} ${url} ${opts.body ?? ""}`).digest("hex");
  const file = opts.cacheDir ? path.join(opts.cacheDir, "http", `${key}.json`) : null;
  const cached = file ? await readCache(file) : null;
  if (cached && opts.ttlMs && Date.now() - Date.parse(cached.fetchedAt) < opts.ttlMs) {
    return { ...cached, fromCache: true };
  }

  const headers: Record<string, string> = { "user-agent": USER_AGENT, ...opts.headers };
  if (cached?.headers.etag) headers["if-none-match"] = cached.headers.etag;
  if (cached?.headers["last-modified"]) headers["if-modified-since"] = cached.headers["last-modified"];

  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
      res = await fetch(url, {
        method,
        headers,
        body: opts.body,
        redirect: opts.redirect ?? "follow",
        signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      });
    } catch (err) {
      if (opts.signal?.aborted || attempt >= retries) {
        const reason = err instanceof Error && err.name === "TimeoutError" ? `timed out after ${(opts.timeoutMs ?? 15_000) / 1000}s` : String(err instanceof Error ? (err.cause ?? err.message) : err);
        throw new HttpError(`${method} ${url} failed: ${reason}`, 0, url);
      }
      await sleep(backoff(attempt), opts.signal);
      continue;
    }

    if (res.status === 304 && cached && file) {
      const refreshed = { ...cached, fetchedAt: new Date().toISOString() };
      await writeCache(file, refreshed);
      return { ...refreshed, fromCache: true };
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await res.body?.cancel();
      const after = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : backoff(attempt), opts.signal);
      continue;
    }

    const body = await readLimited(res, opts.maxBytes ?? 5_000_000, url);
    const kept: Record<string, string> = {};
    for (const h of KEEP_HEADERS) {
      const v = res.headers.get(h);
      if (v) kept[h] = v;
    }
    const isRedirect = res.status >= 300 && res.status < 400 && opts.redirect === "manual";
    if (!res.ok && !isRedirect) {
      throw new HttpError(`${method} ${url} returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`, res.status, url);
    }
    const entry: CacheEntry = { url: res.url || url, status: res.status, headers: kept, body, fetchedAt: new Date().toISOString() };
    if (file && res.status === 200) await writeCache(file, entry);
    return { ...entry, fromCache: false };
  }
}

export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<{ data: T; res: HttpResponse }> {
  const res = await http(url, { ...opts, headers: { accept: "application/json", ...opts.headers } });
  try {
    return { data: JSON.parse(res.body) as T, res };
  } catch {
    throw new HttpError(`${url} did not return JSON`, res.status, url);
  }
}

async function readLimited(res: Response, maxBytes: number, url: string): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new HttpError(`${url} is larger than ${Math.round(maxBytes / 1_000_000)} MB`, res.status, url);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readCache(file: string): Promise<CacheEntry | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as CacheEntry;
  } catch {
    return null;
  }
}

async function writeCache(file: string, entry: CacheEntry): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(entry));
  } catch {
    // a read-only or full cache directory must not break the request
  }
}

function backoff(attempt: number): number {
  return 500 * 2 ** attempt + Math.random() * 250;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
