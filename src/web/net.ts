import dns from "node:dns/promises";
import net from "node:net";
import { http, type HttpOptions, type HttpResponse } from "./http.js";

/**
 * Guard for fetching URLs chosen by the model or by registry metadata: only http(s), no
 * embedded credentials, and no hosts that resolve to loopback, private, link-local (cloud
 * metadata) or other non-public addresses, in any IPv4 or IPv6 spelling.
 * Residual risk: DNS can change between this check and the request (rebinding).
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`only http and https URLs are allowed: ${raw}`);
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new Error(`could not resolve ${url.hostname}`);
  for (const addr of addresses) {
    if (!isPublicAddress(addr)) throw new Error(`${url.hostname} resolves to a non-public address (${addr}); refusing to fetch it`);
  }
  return url;
}

/**
 * GET a URL from an untrusted source: public hosts only, with every redirect hop re-checked.
 * `onRedirect` may throw to refuse a hop (fetch_url uses it to stop official → other-site redirects).
 */
export async function fetchPublic(url: string, opts: HttpOptions, onRedirect?: (next: string) => void): Promise<HttpResponse & { url: string }> {
  let current = url;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current);
    const res = await http(current, { ...opts, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.location : undefined;
    if (!location) return { ...res, url: current };
    if (hop >= 5) throw new Error("too many redirects");
    const next = new URL(location, current).toString();
    onRedirect?.(next);
    current = next;
  }
}

export function isPublicAddress(addr: string): boolean {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast and reserved
    );
  }
  const b = ipv6Bytes(addr);
  if (!b) return false;
  const zeros = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return isPublicAddress(b.slice(12).join(".")); // ::ffff:a.b.c.d
  if (zeros(12)) return false; // ::, ::1 and IPv4-compatible ::a.b.c.d
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return false; // NAT64 embeds an IPv4 address
  if (b[0] === 0x20 && b[1] === 0x02) return false; // 6to4 embeds an IPv4 address
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0 && b[3] === 0) || (b[2] === 0x0d && b[3] === 0xb8))) return false; // Teredo, documentation
  return (b[0] & 0xe0) === 0x20; // global unicast 2000::/3 only
}

/** The 16 bytes of an IPv6 address (any spelling, including a dotted-quad tail), or null. */
function ipv6Bytes(addr: string): number[] | null {
  let s = addr.toLowerCase().split("%")[0];
  let v4: number[] | null = null;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) {
    v4 = tail.slice(1).map(Number);
    s = `${s.slice(0, tail.index)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff]);
  if (v4) bytes.splice(12, 4, ...v4);
  return bytes;
}
