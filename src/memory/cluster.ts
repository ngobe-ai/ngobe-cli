/**
 * Group recurring failures without labels: error text is normalized into a signature
 * (paths, numbers, quoted values and hashes replaced by placeholders), identical
 * signatures are grouped, and groups whose token sets overlap enough are merged.
 * A cluster says "this keeps happening", not why.
 */

export function signature(message: string): string {
  return message
    .toLowerCase()
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, "<s>")
    .replace(/(?:[a-z]:)?(?:[\w.-]*\/)+[\w.-]+/g, "<path>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<hex>")
    .replace(/\d+(\.\d+)*/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export interface FailureRow {
  signature: string;
  sample: string;
  tool: string;
  at: string;
}

export interface Cluster {
  signature: string;
  count: number;
  tools: string[];
  sample: string;
  lastSeen: string;
}

function tokens(s: string): Set<string> {
  return new Set(s.split(/[^a-z<>]+/).filter((t) => t.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 1 : shared / union;
}

export function clusterFailures(rows: FailureRow[], threshold = 0.6): Cluster[] {
  const groups: (Cluster & { tok: Set<string> })[] = [];
  const bySig = new Map<string, Cluster & { tok: Set<string> }>();
  for (const r of rows) {
    let g = bySig.get(r.signature);
    if (!g) {
      const tok = tokens(r.signature);
      g = groups.find((x) => jaccard(x.tok, tok) >= threshold);
      if (!g) {
        g = { signature: r.signature, count: 0, tools: [], sample: r.sample, lastSeen: r.at, tok };
        groups.push(g);
      }
      bySig.set(r.signature, g);
    }
    g.count++;
    if (!g.tools.includes(r.tool)) g.tools.push(r.tool);
    if (r.at > g.lastSeen) {
      g.lastSeen = r.at;
      g.sample = r.sample;
    }
  }
  return groups.map(({ tok: _tok, ...c }) => c).sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
}
