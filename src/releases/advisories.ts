import { httpJson } from "../web/http.js";
import { resolveTarget, type LookupContext } from "./versions.js";

export interface Advisory {
  id: string;
  aliases: string[];
  summary: string;
  severity?: string;
  published?: string;
  /** Versions that fix it, where the database says. */
  fixed: string[];
  url: string;
}

export interface AdvisoryReport {
  name: string;
  ecosystem: string;
  version?: string;
  advisories: Advisory[];
  source: string;
  checkedAt: string;
}

/** Our ecosystem names → OSV's. OSV aggregates GitHub, PyPA, Go, RustSec and others. */
const OSV_ECOSYSTEM: Record<string, string> = {
  npm: "npm",
  pypi: "PyPI",
  pub: "Pub",
  packagist: "Packagist",
  crates: "crates.io",
  go: "Go",
};

interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  published?: string;
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
  affected?: { ranges?: { events?: { fixed?: string }[] }[] }[];
}

/** Known vulnerabilities for a package (affecting a given version, if one is passed), from OSV.dev. */
export async function securityAdvisories(name: string, ecosystem: string | undefined, version: string | undefined, ctx: LookupContext = {}): Promise<AdvisoryReport> {
  const target = resolveTarget(name, ecosystem);
  const osvEco = OSV_ECOSYSTEM[target.ecosystem];
  if (!osvEco) {
    throw new Error(
      `OSV has no package database for ${target.ecosystem}. Use web_search for "${name} security advisory" or the project's GitHub security page.`,
    );
  }
  const url = "https://api.osv.dev/v1/query";
  const body = { package: { name: target.pkg, ecosystem: osvEco }, ...(version ? { version } : {}) };
  const { data, res } = await httpJson<{ vulns?: OsvVuln[] }>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cacheDir: ctx.config?.cacheDir,
    ttlMs: 60 * 60_000,
    timeoutMs: 20_000,
    signal: ctx.signal,
  });
  const advisories = (data.vulns ?? []).map((v) => ({
    id: v.id,
    aliases: v.aliases ?? [],
    summary: v.summary ?? v.details?.split("\n")[0]?.slice(0, 200) ?? "",
    severity: v.database_specific?.severity ?? v.severity?.[0]?.score,
    published: v.published?.slice(0, 10),
    fixed: [...new Set((v.affected ?? []).flatMap((a) => (a.ranges ?? []).flatMap((r) => (r.events ?? []).flatMap((e) => (e.fixed ? [e.fixed] : [])))))],
    url: `https://osv.dev/vulnerability/${v.id}`,
  }));
  return { name: target.pkg, ecosystem: target.ecosystem, version, advisories, source: url, checkedAt: res.fetchedAt };
}
