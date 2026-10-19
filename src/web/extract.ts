/**
 * Readable text from an HTML page: drops scripts, styles and page chrome, keeps headings as
 * markdown "#" lines, list items, and <pre> blocks verbatim. Good enough for documentation;
 * no DOM, no dependencies.
 */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode(stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")).trim();

  let s = html.replace(/<!--[\s\S]*?-->/g, " ");
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(s);
  if (main && main[2].length > 500) s = main[2];
  s = s.replace(/<(script|style|noscript|svg|template|iframe|nav|footer|aside|form|button)\b[\s\S]*?<\/\1>/gi, " ");

  // Code blocks keep their whitespace: park them before collapsing everything else.
  const blocks: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => {
    blocks.push("```\n" + decode(stripTags(code)).replace(/\n+$/, "") + "\n```");
    return `\n\u0000${blocks.length - 1}\u0000\n`;
  });

  s = s
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${stripTags(t).trim()}\n\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|dl|dt|dd|blockquote|li)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ");
  s = decode(stripTags(s));
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => blocks[Number(i)])
    .trim();
  return { title, text: s };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  rarr: "→",
  larr: "←",
};

export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
