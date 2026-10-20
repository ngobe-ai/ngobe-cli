import { execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { gunzipSync, strFromU8, unzipSync } from "fflate";
import { childEnv } from "./childEnv.js";
import { openDb } from "./memory/db.js";
import { htmlToText } from "./web/extract.js";

/**
 * Readable content from files that aren't plain text: documents (PDF, Office, OpenDocument,
 * EPUB, RTF), data (CSV, JSON, notebooks, SQLite), mail, certificates, archives, images, audio,
 * video and executables. Everything runs locally; command-line tools are used when they are
 * installed and do better (pdftotext, ffprobe, tesseract, textutil, plutil, tar, 7z). Anything
 * unrecognized is identified by its first bytes and its readable strings. Nothing is executed or
 * unpickled, and private keys are never shown.
 */

export interface Extracted {
  /** One line about the file: "PDF, 12 pages, 1.2 MB". */
  summary: string;
  /** The readable content; read_file numbers and pages it like a text file. */
  text: string;
}

/** Files larger than this are only read in part (the start), and described from their path. */
export const MAX_LOAD = 64 * 1024 * 1024;
const MAX_TEXT = 400_000;
const MAX_ROWS = 200;
const MAX_LIST = 300;

/**
 * What a file holds, or null for plain text and code (read_file shows those as they are).
 * `buf` is the whole file, or its first MAX_LOAD bytes when `size` says it is bigger.
 */
export interface ExtractOptions {
  /** Describe an image (a vision model); null or a throw falls back to OCR. */
  vision?: (file: string, buf: Uint8Array) => Promise<string | null>;
}

export async function extractDocument(file: string, buf: Uint8Array, size = buf.length, opts: ExtractOptions = {}): Promise<Extracted | null> {
  const ext = path.extname(file).toLowerCase();
  const partial = size > buf.length;
  const done = (summary: string, text: string): Extracted => ({ summary: `${summary}${summary.includes(human(size)) ? "" : `, ${human(size)}`}`, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[… cut at ${MAX_TEXT} characters]` : text });

  if (startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff])) {
    const text = new TextDecoder(buf[0] === 0xff ? "utf-16le" : "utf-16be").decode(buf);
    return (await fromText(file, ext, text)) ?? done(`text (UTF-16)`, text);
  }
  if (!buf.subarray(0, 8000).includes(0) && !BINARY_EXT.has(ext) && !isMagic(buf)) {
    return fromText(file, ext, strFromU8(buf, true)).then((r) => r && done(r.summary, r.text));
  }

  try {
    const r = await fromBinary(file, ext, buf, size, partial, opts);
    return done(r.summary, r.text);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return done(`${describeMagic(buf, ext) ?? "binary data"} (could not be read: ${why.slice(0, 120)})`, stringsOf(buf));
  }
}

// ---------------------------------------------------------------- text formats

async function fromText(file: string, ext: string, text: string): Promise<Extracted | null> {
  if (ext === ".csv" || ext === ".tsv") return csv(text, ext === ".tsv" ? "\t" : ",");
  if (ext === ".ipynb") return notebook(text);
  if (ext === ".html" || ext === ".htm" || ext === ".xhtml") {
    const page = htmlToText(text);
    return { summary: `HTML page${page.title ? ` "${page.title}"` : ""}`, text: page.text };
  }
  if (ext === ".rtf" || text.startsWith("{\\rtf")) return { summary: "RTF document", text: rtf(text) };
  if (ext === ".eml" || (/^(?:From|Received|Return-Path|Delivered-To|MIME-Version): /m.test(text.slice(0, 2000)) && /^Subject: /m.test(text.slice(0, 4000)) && ext !== ".md")) return email(text);
  if (/-----BEGIN [A-Z0-9 ]+-----/.test(text) && [".pem", ".crt", ".cer", ".key", ".csr", ".pub", ""].includes(ext)) return pem(text);
  if (ext === ".jsonl" || ext === ".ndjson") return jsonLines(text);
  if (ext === ".json" && text.length > 100_000) return jsonOutline(text);
  return null;
}

function csv(text: string, sep: string): Extracted {
  const rows = parseCsv(text, sep);
  const width = Math.max(0, ...rows.map((r) => r.length));
  return { summary: `${sep === "\t" ? "TSV" : "CSV"}, ${rows.length} rows × ${width} columns: ${(rows[0] ?? []).slice(0, 20).join(", ")}`, text };
}

function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

function notebook(text: string): Extracted {
  const nb = JSON.parse(text) as { cells?: { cell_type: string; source: string | string[]; outputs?: Record<string, unknown>[] }[]; metadata?: { kernelspec?: { display_name?: string } } };
  const join = (v: unknown) => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "");
  const cells = nb.cells ?? [];
  const parts = cells.map((c, i) => {
    const outputs = (c.outputs ?? []).map((o) => {
      if (o.output_type === "stream") return join(o.text);
      if (o.output_type === "error") return `${o.ename}: ${o.evalue}`;
      const data = (o.data ?? {}) as Record<string, unknown>;
      return data["text/plain"] ? join(data["text/plain"]) : Object.keys(data).some((k) => k.startsWith("image/")) ? "(image output)" : "";
    });
    const out = outputs.filter(Boolean).join("\n").trim();
    return `--- [${i + 1}] ${c.cell_type} ---\n${join(c.source).trim()}${out ? `\n→ ${out.slice(0, 2000)}` : ""}`;
  });
  const kernel = nb.metadata?.kernelspec?.display_name;
  return { summary: `Jupyter notebook, ${cells.length} cells${kernel ? ` (${kernel})` : ""}`, text: parts.join("\n\n") };
}

function rtf(text: string): string {
  let s = text;
  // Groups that hold no document text: fonts, colors, styles, pictures, \* destinations.
  for (const group of ["fonttbl", "colortbl", "stylesheet", "info", "pict", "\\*"]) {
    for (let i = s.indexOf(`{\\${group}`); i >= 0; i = s.indexOf(`{\\${group}`)) {
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === "\\") j++;
        else if (s[j] === "{") depth++;
        else if (s[j] === "}" && --depth === 0) break;
      }
      s = s.slice(0, i) + s.slice(j + 1);
    }
  }
  return s
    .replace(/\\par[d]? ?|\\line ?/g, "\n")
    .replace(/\\tab ?/g, "\t")
    .replace(/\\'([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_m, n: string) => String.fromCharCode((Number(n) + 65536) % 65536))
    .replace(/\\([{}\\])/g, "$1")
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

function email(raw: string): Extracted {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/);
  const headers = parseHeaders(head);
  const body = rest.join("\n\n");
  const keep = ["from", "to", "cc", "date", "subject"].flatMap((k) => (headers[k] ? [`${k[0].toUpperCase()}${k.slice(1)}: ${decodeWords(headers[k])}`] : []));
  const parts: string[] = [];
  const attachments: string[] = [];
  mimeParts(headers["content-type"] ?? "text/plain", headers["content-transfer-encoding"], body, parts, attachments);
  const text = [...keep, ...(attachments.length ? [`Attachments: ${attachments.join(", ")}`] : []), "", parts.join("\n\n").trim()].join("\n");
  return { summary: `Email: ${decodeWords(headers.subject ?? "(no subject)")}`, text };
}

function parseHeaders(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) out[m[1].toLowerCase()] ??= m[2];
  }
  return out;
}

function mimeParts(type: string, encoding: string | undefined, body: string, texts: string[], attachments: string[]): void {
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) break;
      const [h, ...b] = part.replace(/^\r?\n/, "").split(/\r?\n\r?\n/);
      const hs = parseHeaders(h);
      const name = /filename="?([^";]+)"?/i.exec(hs["content-disposition"] ?? "")?.[1] ?? /name="?([^";]+)"?/i.exec(hs["content-type"] ?? "")?.[1];
      if (name && /attachment/i.test(hs["content-disposition"] ?? "attachment")) attachments.push(name);
      else mimeParts(hs["content-type"] ?? "text/plain", hs["content-transfer-encoding"], b.join("\n\n"), texts, attachments);
    }
    return;
  }
  let text = body;
  if (/base64/i.test(encoding ?? "")) text = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  else if (/quoted-printable/i.test(encoding ?? "")) text = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  if (/^text\/html/i.test(type)) texts.push(htmlToText(text).text);
  else if (/^text\//i.test(type)) texts.push(text.trim());
}

/** =?utf-8?B?…?= and =?utf-8?Q?…?= in headers. */
function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_m, _cs: string, enc: string, data: string) =>
    enc.toUpperCase() === "B" ? Buffer.from(data, "base64").toString("utf8") : data.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))),
  );
}

function pem(text: string): Extracted {
  const blocks = [...text.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g)];
  const lines: string[] = [];
  for (const [block, kind] of blocks) {
    if (/PRIVATE KEY/.test(kind)) {
      lines.push(`${kind}: present (not shown; private keys stay private)`);
      continue;
    }
    if (kind === "CERTIFICATE") {
      try {
        lines.push(describeCert(new crypto.X509Certificate(block)));
        continue;
      } catch {
        // fall through: show the kind only
      }
    }
    lines.push(`${kind}${kind.includes("PUBLIC KEY") ? `\n${block}` : ""}`);
  }
  const hasPrivate = blocks.some(([, k]) => /PRIVATE KEY/.test(k));
  return { summary: `PEM file, ${blocks.length} block${blocks.length === 1 ? "" : "s"}${hasPrivate ? ", including a private key (not shown)" : ""}`, text: lines.join("\n\n") };
}

function describeCert(c: crypto.X509Certificate): string {
  return [`Certificate`, `subject: ${c.subject.replace(/\n/g, ", ")}`, `issuer: ${c.issuer.replace(/\n/g, ", ")}`, `valid: ${c.validFrom} → ${c.validTo}`, c.subjectAltName ? `names: ${c.subjectAltName}` : "", `sha256: ${c.fingerprint256}`]
    .filter(Boolean)
    .join("\n");
}

function jsonLines(text: string): Extracted {
  const lines = text.split("\n").filter((l) => l.trim());
  let fields: string[] = [];
  try {
    fields = Object.keys(JSON.parse(lines[0] ?? "{}") as object);
  } catch {
    // not JSON after all: shown as text
  }
  return { summary: `JSON Lines, ${lines.length} records${fields.length ? `; fields: ${fields.slice(0, 20).join(", ")}` : ""}`, text };
}

/** Big JSON: its shape first (keys, types, array lengths), then the text itself. */
function jsonOutline(text: string): Extracted {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { summary: "JSON (invalid)", text };
  }
  const lines: string[] = [];
  const walk = (v: unknown, at: string, depth: number) => {
    if (lines.length > 80) return;
    if (Array.isArray(v)) {
      lines.push(`${at}: array of ${v.length}`);
      if (v.length && depth < 3) walk(v[0], `${at}[0]`, depth + 1);
    } else if (v && typeof v === "object") {
      const keys = Object.keys(v);
      lines.push(`${at}: object with ${keys.length} keys`);
      if (depth < 3) for (const k of keys.slice(0, 25)) walk((v as Record<string, unknown>)[k], `${at}.${k}`, depth + 1);
    } else lines.push(`${at}: ${v === null ? "null" : typeof v}`);
  };
  walk(value, "$", 0);
  return { summary: `JSON, ${human(text.length)}`, text: `Shape:\n${lines.join("\n")}\n\n--- the file ---\n${text}` };
}

// ---------------------------------------------------------------- binary formats

async function fromBinary(file: string, ext: string, buf: Uint8Array, size: number, partial: boolean, opts: ExtractOptions): Promise<Extracted> {
  if (startsWith(buf, "%PDF")) return pdf(file, buf, partial);
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) return zipLike(file, ext, buf, partial);
  if (startsWith(buf, [0x1f, 0x8b])) return gzip(file, ext, buf, partial);
  if (isTar(buf)) return { ...tarListing(buf, "tar archive") };
  if (startsWith(buf, "SQLite format 3\0")) return sqlite(file);
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return legacyOffice(file, ext, buf);
  if (startsWith(buf, "bplist00")) {
    const json = await tool("plutil", ["-convert", "json", "-o", "-", file]);
    return { summary: "binary property list (plist)", text: json ?? stringsOf(buf) };
  }

  const image = imageInfo(buf);
  if (image) {
    let seen: string | null = null;
    let failed = "";
    try {
      seen = (await opts.vision?.(file, buf)) ?? null;
    } catch (err) {
      failed = ` (the vision model failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)})`;
    }
    if (seen) return { summary: image, text: `What the image shows (from the vision model):\n${seen}` };
    const ocr = await tool("tesseract", [file, "stdout"], 60_000);
    return {
      summary: image,
      text: ocr?.trim()
        ? `Text found in the image (OCR)${failed}:\n${ocr.trim()}`
        : ocr === null
          ? `(The model can't see images${failed}. Set NGOBE_VISION_MODEL to a vision model on the server, or install tesseract to read text in images.)`
          : `(No text found in the image${failed}.)`,
    };
  }

  const wav = wavInfo(buf);
  if (wav) return { summary: wav, text: "" };
  const media = mediaKind(buf);
  if (media) {
    const probe = await ffprobe(file);
    return probe ?? { summary: `${media}${media.startsWith("MP3") ? id3(buf) : ""}`, text: "(Install ffmpeg for duration and codecs: brew install ffmpeg / apt install ffmpeg.)" };
  }

  const exe = executableInfo(buf, ext);
  if (exe) return { summary: exe, text: `Readable strings (a sample):\n${stringsOf(buf)}` };

  if (startsWith(buf, [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59])) {
    const len = buf[8] | (buf[9] << 8);
    return { summary: `NumPy array ${strFromU8(buf.subarray(10, 10 + len)).trim()}`, text: "" };
  }
  if ([".pkl", ".pickle"].includes(ext) || (buf[0] === 0x80 && buf[1] >= 2 && buf[1] <= 5 && ext !== ".bin")) {
    return { summary: "Python pickle (not loaded: unpickling can run code)", text: stringsOf(buf) };
  }
  if (startsWith(buf, [0x30, 0x82])) {
    try {
      return { summary: "DER certificate", text: describeCert(new crypto.X509Certificate(Buffer.from(buf))) };
    } catch {
      // not a certificate
    }
  }

  const archive = archiveKind(buf, ext);
  if (archive) {
    const listing = (await tool("tar", ["-tvf", file])) ?? (await tool("7z", ["l", file]));
    return { summary: archive, text: listing ? cap(listing.trim().split("\n"), MAX_LIST).join("\n") : "(Install 7-Zip (7z) to list this archive.)" };
  }

  const known = describeMagic(buf, ext);
  return { summary: known ?? `binary data (${size} bytes; first bytes ${hex(buf.subarray(0, 8))})`, text: `Readable strings (a sample):\n${stringsOf(buf)}` };
}

async function pdf(file: string, buf: Uint8Array, partial: boolean): Promise<Extracted> {
  let pages: string[] | null = null;
  const out = await tool("pdftotext", ["-enc", "UTF-8", file, "-"], 120_000);
  if (out !== null) {
    pages = out.split("\f");
    if (pages.length > 1 && !pages.at(-1)!.trim()) pages.pop();
  } else if (!partial) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    pages = (await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: false })).text as string[];
  }
  if (!pages) return { summary: "PDF (too large to read without pdftotext: brew install poppler / apt install poppler-utils)", text: "" };
  const text = pages.map((p, i) => `--- page ${i + 1} ---\n${p.replace(/[ \t]+$/gm, "").trim()}`).join("\n\n");
  const blank = pages.every((p) => !p.trim());
  return { summary: `PDF, ${pages.length} page${pages.length === 1 ? "" : "s"}${blank ? "; no text layer (a scan: OCR it with tesseract)" : ""}`, text };
}

/** Zip and everything built on it: Office, OpenDocument, EPUB, iWork, jar/apk/whl, plain zip. */
async function zipLike(file: string, ext: string, buf: Uint8Array, partial: boolean): Promise<Extracted> {
  if (partial) {
    const listing = (await tool("unzip", ["-l", file])) ?? (await tool("tar", ["-tvf", file]));
    return { summary: "zip archive (large; listed, not opened)", text: listing ?? "" };
  }
  const entries: { name: string; size: number }[] = [];
  unzipSync(buf, {
    filter: (f) => {
      entries.push({ name: f.name, size: f.originalSize });
      return false;
    },
  });
  const names = new Set(entries.map((e) => e.name));
  const read = (want: (name: string) => boolean): Record<string, string> =>
    Object.fromEntries(Object.entries(unzipSync(buf, { filter: (f) => want(f.name) })).map(([k, v]) => [k, strFromU8(v)]));

  if (names.has("word/document.xml")) {
    const xml = read((n) => n === "word/document.xml")["word/document.xml"];
    const text = docx(xml);
    return { summary: `Word document, ~${words(text)} words`, text };
  }
  if (names.has("xl/workbook.xml")) return xlsx(read((n) => n.startsWith("xl/") && n.endsWith(".xml")) as Record<string, string>, read((n) => n === "xl/_rels/workbook.xml.rels")["xl/_rels/workbook.xml.rels"]);
  if (names.has("ppt/presentation.xml")) {
    const slides = Object.entries(read((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))).sort((a, b) => num(a[0]) - num(b[0]));
    const text = slides.map(([, xml], i) => `--- slide ${i + 1} ---\n${paragraphs(xml, "a:p", "a:t")}`).join("\n\n");
    return { summary: `PowerPoint presentation, ${slides.length} slide${slides.length === 1 ? "" : "s"}`, text };
  }
  if (names.has("mimetype")) {
    const mime = read((n) => n === "mimetype").mimetype.trim();
    if (mime.startsWith("application/vnd.oasis.opendocument.")) return odf(mime, read((n) => n === "content.xml")["content.xml"] ?? "");
    if (mime === "application/epub+zip") return epub(read);
  }
  const preview = [...names].find((n) => /(^|\/)(QuickLook\/)?Preview\.pdf$/i.test(n));
  if (preview) {
    const bytes = unzipSync(buf, { filter: (f) => f.name === preview })[preview];
    const { extractText, getDocumentProxy } = await import("unpdf");
    const text = ((await extractText(await getDocumentProxy(bytes), { mergePages: true })).text as string).trim();
    return { summary: `${{ ".pages": "Pages document", ".numbers": "Numbers spreadsheet", ".key": "Keynote presentation" }[ext] ?? "document"} (text from its preview)`, text };
  }

  const kind = { ".jar": "Java archive", ".war": "Java web archive", ".apk": "Android app", ".aab": "Android app bundle", ".ipa": "iOS app", ".whl": "Python wheel", ".nupkg": "NuGet package", ".vsix": "VS Code extension", ".xpi": "Firefox extension", ".docm": "Word document", ".aar": "Android library" }[ext] ?? "zip archive";
  const extra: string[] = [];
  const manifest = [...names].find((n) => n === "META-INF/MANIFEST.MF" || /\.dist-info\/METADATA$/.test(n) || n === "package.json" || n === "extension.vsixmanifest");
  if (manifest) extra.push(`--- ${manifest} ---`, (read((n) => n === manifest)[manifest] ?? "").split("\n").slice(0, 40).join("\n"));
  const total = entries.reduce((n, e) => n + e.size, 0);
  const listing = cap(entries.map((e) => `${String(e.size).padStart(10)}  ${e.name}`), MAX_LIST);
  return { summary: `${kind}, ${entries.length} entries, ${human(total)} unpacked`, text: [...listing, ...(extra.length ? ["", ...extra] : [])].join("\n") };
}

function docx(xml: string): string {
  const body = xml.replace(/^[\s\S]*?<w:body>/, "");
  const blocks = body.match(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g) ?? [];
  return blocks
    .map((b) =>
      b.startsWith("<w:tbl>")
        ? (b.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []).map((row) => (row.match(/<w:tc[ >][\s\S]*?<\/w:tc>/g) ?? []).map((cell) => runText(cell).replace(/\n/g, " ").trim()).join("\t")).join("\n")
        : runText(b),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The text of Word runs: <w:t>, tabs and breaks, paragraphs on their own lines. */
function runText(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>|<\/w:p>/g)) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (m[0] === "<w:tab/>") out += "\t";
    else out += "\n";
  }
  return out.replace(/\n$/, "");
}

/** Paragraph elements of a drawing or ODF document, each the join of its text runs. */
function paragraphs(xml: string, para: string, run: string): string {
  const re = new RegExp(String.raw`<${para}[ >][\s\S]*?<\/${para}>|<${para}\/>`, "g");
  const runRe = new RegExp(String.raw`<${run}(?:\s[^>]*)?>([^<]*)<\/${run}>`, "g");
  return (xml.match(re) ?? []).map((p) => [...p.matchAll(runRe)].map((m) => decodeXml(m[1])).join("")).filter((l) => l.trim()).join("\n");
}

function xlsx(files: Record<string, string>, rels?: string): Extracted {
  const shared = (files["xl/sharedStrings.xml"]?.match(/<si>[\s\S]*?<\/si>/g) ?? []).map((si) => [...si.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decodeXml(m[1])).join(""));
  const targets = new Map([...(rels ?? "").matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], `xl/${m[2].replace(/^\/?xl\//, "")}`]));
  const sheets = [...(files["xl/workbook.xml"] ?? "").matchAll(/<sheet [^>]*name="([^"]+)"[^>]*?(?:r:id="([^"]+)")?[^>]*\/>/g)].map((m, i) => ({
    name: decodeXml(m[1]),
    file: (m[2] && targets.get(m[2])) || `xl/worksheets/sheet${i + 1}.xml`,
  }));
  const parts = sheets.map((s) => {
    const rows = (files[s.file]?.match(/<row[ >][\s\S]*?<\/row>/g) ?? []).map((row) => {
      const cells: string[] = [];
      for (const c of row.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /r="([A-Z]+)\d+"/.exec(c[1])?.[1];
        const type = /t="([^"]+)"/.exec(c[1])?.[1];
        const v = /<v>([^<]*)<\/v>/.exec(c[2] ?? "")?.[1];
        const value = type === "s" ? (shared[Number(v)] ?? "") : type === "inlineStr" ? [...(c[2] ?? "").matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => decodeXml(m[1])).join("") : type === "b" ? (v === "1" ? "TRUE" : "FALSE") : decodeXml(v ?? "");
        const col = ref ? colIndex(ref) : cells.length;
        while (cells.length < col) cells.push("");
        cells[col] = value;
      }
      return cells.join("\t");
    });
    const more = rows.length > MAX_ROWS ? `\n[${rows.length - MAX_ROWS} more rows]` : "";
    return `--- sheet ${s.name} (${rows.length} rows) ---\n${rows.slice(0, MAX_ROWS).join("\n")}${more}`;
  });
  return { summary: `Excel workbook, ${sheets.length} sheet${sheets.length === 1 ? "" : "s"}: ${sheets.map((s) => s.name).join(", ")}`, text: parts.join("\n\n").replace(/--- sheet (.+?) \(\d+ rows\) ---/g, (m, n: string) => (sheets.length === 1 ? `--- sheet ${n} ---` : m)) };
}

function odf(mime: string, xml: string): Extracted {
  const kind = mime.split(".").pop() ?? "document";
  if (kind === "spreadsheet") {
    const tables = [...xml.matchAll(/<table:table [^>]*table:name="([^"]+)"[^>]*>([\s\S]*?)<\/table:table>/g)].map(([, name, body]) => {
      const rows = (body.match(/<table:table-row[ >][\s\S]*?<\/table:table-row>/g) ?? []).map((r) => (r.match(/<table:table-cell[^>]*?(?:\/>|>[\s\S]*?<\/table:table-cell>)/g) ?? []).map((c) => paragraphs(c, "text:p", "text:span|text:s") || decodeXml(c.replace(/<[^>]+>/g, ""))).join("\t").replace(/\t+$/, ""));
      return `--- sheet ${decodeXml(name)} ---\n${rows.filter(Boolean).slice(0, MAX_ROWS).join("\n")}`;
    });
    return { summary: `OpenDocument spreadsheet, ${tables.length} sheets`, text: tables.join("\n\n") };
  }
  const lines = (xml.match(/<text:(?:p|h)[ >][\s\S]*?<\/text:(?:p|h)>|<draw:page /g) ?? []).map((p) => (p === "<draw:page " ? "\f" : decodeXml(p.replace(/<text:tab\/>/g, "\t").replace(/<[^>]+>/g, ""))));
  if (kind === "presentation") {
    const slides = lines.join("\n").split("\f").slice(1);
    return { summary: `OpenDocument presentation, ${slides.length} slides`, text: slides.map((s, i) => `--- slide ${i + 1} ---\n${s.trim()}`).join("\n\n") };
  }
  const text = lines.filter((l) => l.trim()).join("\n");
  return { summary: `OpenDocument ${kind}, ~${words(text)} words`, text };
}

function epub(read: (want: (name: string) => boolean) => Record<string, string>): Extracted {
  const container = read((n) => n === "META-INF/container.xml")["META-INF/container.xml"] ?? "";
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1] ?? "";
  const opf = read((n) => n === opfPath)[opfPath] ?? "";
  const base = path.posix.dirname(opfPath);
  const title = decodeXml(/<dc:title[^>]*>([^<]*)<\/dc:title>/.exec(opf)?.[1] ?? "");
  const hrefs = new Map([...opf.matchAll(/<item [^>]*id="([^"]+)"[^>]*href="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const order = [...opf.matchAll(/<itemref [^>]*idref="([^"]+)"/g)].map((m) => hrefs.get(m[1])).filter((h): h is string => !!h).map((h) => (base === "." ? h : `${base}/${h}`));
  const files = read((n) => order.includes(n));
  const chapters = order.map((f) => htmlToText(files[f] ?? "").text.trim()).filter(Boolean);
  return { summary: `EPUB book${title ? ` "${title}"` : ""}, ${chapters.length} sections`, text: chapters.map((c, i) => `--- section ${i + 1} ---\n${c}`).join("\n\n") };
}

async function gzip(file: string, ext: string, buf: Uint8Array, partial: boolean): Promise<Extracted> {
  if (partial) {
    const listing = await tool("tar", ["-tvzf", file]);
    return { summary: "gzip file (large; listed, not unpacked)", text: listing ?? "" };
  }
  const inner = gunzipSync(buf);
  if (isTar(inner)) return tarListing(inner, "tar archive (gzip)");
  const name = file.replace(/\.gz$|\.tgz$/i, "");
  if (!inner.subarray(0, 8000).includes(0)) return { summary: `gzip-compressed text, ${human(inner.length)} unpacked`, text: strFromU8(inner, true) };
  const r = await extractDocument(name, inner);
  return r ? { summary: `gzip-compressed ${r.summary}`, text: r.text } : { summary: `gzip-compressed data, ${human(inner.length)} unpacked`, text: stringsOf(inner) };
}

function isTar(buf: Uint8Array): boolean {
  return buf.length >= 512 && strFromU8(buf.subarray(257, 262)) === "ustar";
}

function tarListing(buf: Uint8Array, label: string): Extracted {
  const lines: string[] = [];
  let longName: string | null = null;
  for (let at = 0; at + 512 <= buf.length; ) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const field = (from: number, len: number) => strFromU8(h.subarray(from, from + len)).replace(/\0[\s\S]*$/, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const body = buf.subarray(at + 512, at + 512 + size);
    if (type === "L") longName = strFromU8(body).replace(/\0[\s\S]*$/, "");
    else if (type !== "x" && type !== "g") {
      const prefix = field(345, 155);
      const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
      longName = null;
      lines.push(`${String(size).padStart(10)}  ${name}${type === "5" ? "/" : type === "2" ? " (link)" : ""}`);
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return { summary: `${label}, ${lines.length} entries`, text: cap(lines, MAX_LIST).join("\n") };
}

function sqlite(file: string): Extracted {
  const db = openDb(file, { readOnly: true });
  try {
    const objects = db.all<{ name: string; type: string }>("select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by type, name");
    const tables = objects.filter((o) => o.type === "table");
    const quote = (n: string) => `"${n.replace(/"/g, '""')}"`;
    const parts = tables.slice(0, 40).map((t) => {
      const cols = db.all<{ name: string; type: string }>(`pragma table_info(${quote(t.name)})`);
      const count = db.get<{ n: number }>(`select count(*) as n from ${quote(t.name)}`)?.n ?? 0;
      const sample = db.all<Record<string, unknown>>(`select * from ${quote(t.name)} limit 3`).map((r) => JSON.stringify(r, (_k, v) => (typeof v === "string" && v.length > 80 ? `${v.slice(0, 80)}…` : v)));
      return `${t.name} (${count} rows): ${cols.map((c) => `${c.name} ${c.type.toLowerCase()}`.trim()).join(", ")}${sample.length ? `\n  ${sample.join("\n  ")}` : ""}`;
    });
    const views = objects.filter((o) => o.type === "view").map((v) => v.name);
    return { summary: `SQLite database, ${tables.length} table${tables.length === 1 ? "" : "s"}${views.length ? `, ${views.length} views` : ""}`, text: [...parts, ...(views.length ? [`Views: ${views.join(", ")}`] : [])].join("\n") };
  } finally {
    db.close();
  }
}

async function legacyOffice(file: string, ext: string, buf: Uint8Array): Promise<Extracted> {
  const kind = { ".doc": "Word 97–2003 document", ".xls": "Excel 97–2003 workbook", ".ppt": "PowerPoint 97–2003 presentation", ".msg": "Outlook message" }[ext] ?? "Microsoft compound file";
  const converted =
    ext === ".doc"
      ? ((await tool("textutil", ["-convert", "txt", "-stdout", file])) ?? (await tool("antiword", [file])) ?? (await tool("catdoc", [file])))
      : ext === ".xls"
        ? await tool("xls2csv", [file])
        : null;
  return { summary: kind, text: converted?.trim() || `Readable text (a sample; save it as a newer format for a full read):\n${stringsOf(buf, true)}` };
}

// ---------------------------------------------------------------- media and executables

function imageInfo(b: Uint8Array): string | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47]) && b.length >= 26) {
    const color = { 0: "grayscale", 2: "RGB", 3: "palette", 4: "grayscale + alpha", 6: "RGBA" }[b[25]] ?? "";
    return `PNG image, ${v.getUint32(16)}×${v.getUint32(20)}${color ? `, ${color}` : ""}`;
  }
  if (startsWith(b, [0xff, 0xd8, 0xff])) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1];
      const len = v.getUint16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return `JPEG image, ${v.getUint16(i + 7)}×${v.getUint16(i + 5)}${includesAscii(b.subarray(0, 64), "Exif") ? ", with EXIF data" : ""}`;
      i += 2 + len;
    }
    return "JPEG image";
  }
  if (startsWith(b, "GIF8") && b.length >= 10) return `GIF image, ${v.getUint16(6, true)}×${v.getUint16(8, true)}`;
  if (startsWith(b, "RIFF") && strFromU8(b.subarray(8, 12)) === "WEBP" && b.length >= 30) {
    const chunk = strFromU8(b.subarray(12, 16));
    if (chunk === "VP8X") return `WebP image, ${1 + (b[24] | (b[25] << 8) | (b[26] << 16))}×${1 + (b[27] | (b[28] << 8) | (b[29] << 16))}`;
    if (chunk === "VP8L") return `WebP image, ${1 + (v.getUint16(21, true) & 0x3fff)}×${1 + ((v.getUint32(21, true) >> 14) & 0x3fff)}`;
    return `WebP image, ${v.getUint16(26, true) & 0x3fff}×${v.getUint16(28, true) & 0x3fff}`;
  }
  if (startsWith(b, "BM") && b.length >= 26) return `BMP image, ${v.getInt32(18, true)}×${Math.abs(v.getInt32(22, true))}`;
  if (startsWith(b, "8BPS") && b.length >= 22) return `Photoshop image, ${v.getUint32(18)}×${v.getUint32(14)}`;
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a])) return "TIFF image";
  if (startsWith(b, [0, 0, 1, 0]) && b.length > 6) return `icon (ICO), ${v.getUint16(4, true)} images`;
  const brand = strFromU8(b.subarray(4, 12));
  if (/^ftyp(heic|heix|hevc|mif1|msf1)/.test(brand)) return "HEIC image";
  if (/^ftypavi[fs]/.test(brand)) return "AVIF image";
  return null;
}

function wavInfo(b: Uint8Array): string | null {
  if (!startsWith(b, "RIFF") || strFromU8(b.subarray(8, 12)) !== "WAVE") return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let bytesPerSec = 0;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = strFromU8(b.subarray(at, at + 4));
    const len = v.getUint32(at + 4, true);
    if (id === "fmt ") {
      channels = v.getUint16(at + 10, true);
      rate = v.getUint32(at + 12, true);
      bytesPerSec = v.getUint32(at + 16, true);
      bits = v.getUint16(at + 22, true);
    } else if (id === "data" && bytesPerSec) {
      return `WAV audio, ${rate} Hz, ${channels} channel${channels === 1 ? "" : "s"}, ${bits}-bit, ${Number((len / bytesPerSec).toFixed(2))} s`;
    }
    at += 8 + len + (len % 2);
  }
  return "WAV audio";
}

function mediaKind(b: Uint8Array): string | null {
  const brand = strFromU8(b.subarray(4, 8));
  if (brand === "ftyp") return strFromU8(b.subarray(8, 11)) === "M4A" ? "MPEG-4 audio" : strFromU8(b.subarray(8, 10)) === "qt" ? "QuickTime video" : "MPEG-4 media";
  if (startsWith(b, "ID3") || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return "MP3 audio";
  if (startsWith(b, "RIFF") && strFromU8(b.subarray(8, 12)) === "AVI ") return "AVI video";
  if (startsWith(b, "OggS")) return "Ogg media";
  if (startsWith(b, "fLaC")) return "FLAC audio";
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return "Matroska/WebM media";
  if (startsWith(b, "FLV")) return "Flash video";
  if (startsWith(b, "MThd")) return "MIDI music";
  if (startsWith(b, [0x30, 0x26, 0xb2, 0x75])) return "Windows Media file";
  if (startsWith(b, "#!AMR")) return "AMR audio";
  return null;
}

async function ffprobe(file: string): Promise<Extracted | null> {
  const out = await tool("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", file]);
  if (!out) return null;
  const j = JSON.parse(out) as { format?: { format_long_name?: string; duration?: string; bit_rate?: string; tags?: Record<string, string> }; streams?: Record<string, string | number>[] };
  const f = j.format ?? {};
  const streams = (j.streams ?? []).map((s) =>
    s.codec_type === "video"
      ? `video: ${s.codec_name} ${s.width}×${s.height}${s.r_frame_rate ? ` @ ${fps(String(s.r_frame_rate))} fps` : ""}`
      : s.codec_type === "audio"
        ? `audio: ${s.codec_name}, ${s.sample_rate} Hz, ${s.channels} channels`
        : `${s.codec_type}: ${s.codec_name}`,
  );
  const tags = Object.entries(f.tags ?? {}).filter(([k]) => /^(title|artist|album|date|genre|comment|encoder|creation_time)$/i.test(k)).map(([k, v]) => `${k}: ${v}`);
  const duration = f.duration ? `${Number(f.duration).toFixed(1)} s` : "";
  return { summary: [f.format_long_name ?? "media", duration].filter(Boolean).join(", "), text: [...streams, ...tags, f.bit_rate ? `bit rate: ${Math.round(Number(f.bit_rate) / 1000)} kb/s` : ""].filter(Boolean).join("\n") };
}

function fps(rate: string): string {
  const [a, b] = rate.split("/").map(Number);
  return b ? String(Math.round((a / b) * 100) / 100) : rate;
}

/** Title and artist from an ID3v2 tag. */
function id3(b: Uint8Array): string {
  if (!startsWith(b, "ID3")) return "";
  const tags: string[] = [];
  for (const frame of ["TIT2", "TPE1"]) {
    const at = indexOfAscii(b.subarray(0, 4096), frame);
    if (at < 0) continue;
    const len = (b[at + 4] << 24) | (b[at + 5] << 16) | (b[at + 6] << 8) | b[at + 7];
    const enc = b[at + 10];
    const data = b.subarray(at + 11, at + 10 + len);
    tags.push(enc === 1 || enc === 2 ? new TextDecoder("utf-16").decode(data) : strFromU8(data, true));
  }
  return tags.length ? `: ${tags.map((t) => t.replace(/\0/g, "").trim()).join(" — ")}` : "";
}

function executableInfo(b: Uint8Array, ext: string): string | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46]) && b.length >= 20) {
    const le = b[5] !== 2;
    const type = { 1: "relocatable object", 2: "executable", 3: "shared object or PIE executable", 4: "core dump" }[v.getUint16(16, le)] ?? "file";
    const machine = { 0x3e: "x86-64", 0xb7: "AArch64", 0x28: "ARM", 0x03: "x86", 0xf3: "RISC-V", 0x08: "MIPS", 0x14: "PowerPC", 0x15: "PowerPC64" }[v.getUint16(18, le)] ?? `machine ${v.getUint16(18, le)}`;
    return `ELF ${b[4] === 2 ? "64" : "32"}-bit ${type}, ${machine}`;
  }
  const magic = b.length >= 16 ? v.getUint32(0) : 0;
  if (magic === 0xcffaedfe || magic === 0xcefaedfe) {
    const cpu = { 0x01000007: "x86-64", 0x0100000c: "arm64", 7: "x86", 12: "ARM" }[v.getUint32(4, true)] ?? "unknown CPU";
    const type = { 1: "object", 2: "executable", 6: "dynamic library", 8: "bundle" }[v.getUint32(12, true)] ?? "file";
    return `Mach-O ${magic === 0xcffaedfe ? "64" : "32"}-bit ${type}, ${cpu}`;
  }
  if (magic === 0xcafebabe) {
    const second = v.getUint32(4);
    if (ext === ".class" || second >>> 16 === 0 && (second & 0xffff) >= 45) return `Java class file (version ${second & 0xffff})`;
    return `Mach-O universal binary, ${second} architectures`;
  }
  if (startsWith(b, "MZ") && b.length >= 64) {
    const pe = v.getUint32(0x3c, true);
    if (pe + 24 < b.length && strFromU8(b.subarray(pe, pe + 4)) === "PE\0\0") {
      const machine = { 0x8664: "x86-64", 0x14c: "x86", 0xaa64: "ARM64" }[v.getUint16(pe + 4, true)] ?? "unknown CPU";
      const dll = (v.getUint16(pe + 22, true) & 0x2000) !== 0;
      return `Windows ${dll ? "DLL" : "executable"} (PE), ${machine}`;
    }
    return "DOS/Windows executable";
  }
  if (startsWith(b, [0, 0x61, 0x73, 0x6d])) return `WebAssembly module (version ${v.getUint32(4, true)})`;
  if (startsWith(b, "dex\n")) return "Android DEX bytecode";
  if (startsWith(b, "!<arch>\n")) return ext === ".deb" ? "Debian package (ar archive)" : "static library / ar archive";
  return null;
}

function archiveKind(b: Uint8Array, ext: string): string | null {
  if (startsWith(b, "BZh")) return "bzip2 archive";
  if (startsWith(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "xz archive";
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7-Zip archive";
  if (startsWith(b, "Rar!")) return "RAR archive";
  if (startsWith(b, [0x28, 0xb5, 0x2f, 0xfd])) return "Zstandard archive";
  if (startsWith(b, "MSCF")) return "Windows cabinet";
  if (b.length > 0x8006 && strFromU8(b.subarray(0x8001, 0x8006)) === "CD001") return "ISO disk image";
  if (ext === ".dmg") return "macOS disk image";
  if (startsWith(b, [0xed, 0xab, 0xee, 0xdb])) return "RPM package";
  if (startsWith(b, "070701") || startsWith(b, "070707")) return "cpio archive";
  return null;
}

/** File kinds known by their first bytes that have no reader here. */
function describeMagic(b: Uint8Array, ext: string): string | null {
  if (startsWith(b, "PAR1")) return "Parquet data file (read it with duckdb, pandas or pyarrow through bash)";
  if (startsWith(b, [0x4f, 0x62, 0x6a, 0x01])) return "Avro data file";
  if (startsWith(b, "ORC")) return "ORC data file";
  if (startsWith(b, "ARROW1")) return "Apache Arrow/Feather file";
  if (startsWith(b, [0x89, 0x48, 0x44, 0x46])) return "HDF5 data file (read it with h5py through bash)";
  if (startsWith(b, "CDF\x01") || startsWith(b, "CDF\x02")) return "NetCDF data file";
  if (startsWith(b, [0x00, 0x01, 0x00, 0x00, 0x00]) || startsWith(b, "OTTO") || startsWith(b, "true")) return "font (TrueType/OpenType)";
  if (startsWith(b, "wOFF") || startsWith(b, "wOF2")) return "web font (WOFF)";
  if (startsWith(b, "ttcf")) return "font collection";
  if (startsWith(b, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50])) return "JPEG 2000 image";
  if (startsWith(b, "glTF")) return "glTF 3D model (binary)";
  if (ext === ".blend" || startsWith(b, "BLENDER")) return "Blender file";
  if (startsWith(b, [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00])) return "Windows shortcut (.lnk)";
  if (startsWith(b, "-----BEGIN PGP")) return "PGP data";
  if (startsWith(b, "KDBX") || startsWith(b, [0x03, 0xd9, 0xa2, 0x9a])) return "KeePass password database (encrypted)";
  return null;
}

function isMagic(b: Uint8Array): boolean {
  return startsWith(b, "%PDF") || startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, "SQLite format 3") || startsWith(b, [0x89, 0x50, 0x4e, 0x47]) || startsWith(b, "bplist00");
}

/** Extensions never shown as text even when their first bytes have no NUL. */
const BINARY_EXT = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".epub", ".zip", ".jar", ".apk", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".mp3", ".mp4", ".mov", ".wav", ".flac", ".ogg", ".mkv", ".webm", ".avi", ".db", ".sqlite", ".sqlite3", ".doc", ".xls", ".ppt", ".class", ".wasm", ".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a", ".npy", ".pkl", ".parquet", ".heic", ".tif", ".tiff", ".psd", ".ttf", ".otf", ".woff", ".woff2", ".dmg", ".iso"]);

// ---------------------------------------------------------------- helpers

/** Printable runs of 6+ characters (ASCII, and UTF-16LE when asked), a sample of at most 120. */
function stringsOf(b: Uint8Array, utf16 = false): string {
  const found: string[] = [];
  const text = strFromU8(b.subarray(0, 4 * 1024 * 1024), true);
  for (const m of text.matchAll(/[\x20-\x7e\t]{6,}/g)) {
    found.push(m[0].trim());
    if (found.length >= 120) break;
  }
  if (utf16 && found.length < 120) {
    const wide = new TextDecoder("utf-16le").decode(b.subarray(0, 4 * 1024 * 1024));
    for (const m of wide.matchAll(/[\x20-\x7e -ɏ\t]{6,}/g)) {
      found.push(m[0].trim());
      if (found.length >= 240) break;
    }
  }
  return found.filter(Boolean).join("\n");
}

/** Run a helper program on the file; null when it isn't installed or fails. */
function tool(cmd: string, args: string[], timeout = 30_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024, env: childEnv(), encoding: "utf8" }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function startsWith(b: Uint8Array, sig: number[] | string): boolean {
  const bytes = typeof sig === "string" ? [...sig].map((c) => c.charCodeAt(0)) : sig;
  return b.length >= bytes.length && bytes.every((x, i) => b[i] === x);
}

function indexOfAscii(b: Uint8Array, s: string): number {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).indexOf(s, 0, "latin1");
}

function includesAscii(b: Uint8Array, s: string): boolean {
  return indexOfAscii(b, s) >= 0;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

function colIndex(letters: string): number {
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}

function num(name: string): number {
  return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function cap(lines: string[], max: number): string[] {
  return lines.length > max ? [...lines.slice(0, max), `[${lines.length - max} more]`] : lines;
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");
}

export function human(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
