import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { gzipSync, strToU8, zipSync } from "fflate";
import { extractDocument } from "../src/documents.js";
import { openDb } from "../src/memory/db.js";
import { readFile } from "../src/tools/readFile.js";
import { needOf } from "../src/permissions.js";
import type { ToolImage } from "../src/types.js";
import { fakeModel, testConfig, tmpDir } from "./helpers.js";

/** Write a fixture and extract it, as read_file does. */
async function extract(name: string, data: Uint8Array | string) {
  const file = path.join(tmpDir(), name);
  fs.writeFileSync(file, data);
  const out = await extractDocument(file, fs.readFileSync(file));
  return out ? `${out.summary}\n${out.text}` : null;
}

/** A minimal PDF with one text line per page, with a correct xref table. */
function pdf(pages: string[]): Uint8Array {
  const objs = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  const font = 3 + pages.length * 2;
  pages.forEach((text, i) => {
    const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  return strToU8(`${out}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

/** A tar archive (ustar headers) of text files. */
function tar(files: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, text] of Object.entries(files)) {
    const header = new Uint8Array(512);
    const put = (s: string, at: number) => header.set(strToU8(s), at);
    put(name, 0);
    put("0000644\0", 100);
    put(`${text.length.toString(8).padStart(11, "0")}\0`, 124);
    put("00000000000\0", 136);
    put("        ", 148);
    put("0", 156);
    put("ustar\0", 257);
    const sum = header.reduce((a, b) => a + b, 0);
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header);
    const body = new Uint8Array(Math.ceil(text.length / 512) * 512);
    body.set(strToU8(text));
    blocks.push(body);
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

describe("documents", () => {
  test("PDF: text by page", async () => {
    const out = await extract("report.pdf", pdf(["Quarterly revenue grew", "Costs fell by ten percent"]));
    expect(out).toContain("PDF, 2 pages");
    expect(out).toContain("--- page 1 ---");
    expect(out).toContain("Quarterly revenue grew");
    expect(out).toContain("--- page 2 ---");
    expect(out).toContain("Costs fell by ten percent");
  });

  test("Word (.docx): paragraphs and tables", async () => {
    const body = `<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Project plan</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Ship on </w:t></w:r><w:r><w:t>Friday &amp; celebrate</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Bruno</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
    const out = await extract("plan.docx", zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": body }));
    expect(out).toContain("Word document");
    expect(out).toContain("Project plan\nShip on Friday & celebrate");
    expect(out).toContain("Owner\tBruno");
  });

  // Seen live: a 437-paragraph site map, cut by the 6,400-character output cap (32k context
  // budget) to its first and last 3,200 characters; the model never saw most sections.
  test("a long document is paged within the output budget, with the headings further on", async () => {
    const para = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
    const sections = ["HOME", "FIRST STEP", "MY PROFILE", "COACHING PAGE", "READINESS (chargeable)"];
    const body = sections.map((s) => para(s) + Array.from({ length: 80 }, (_, i) => para(`${s.toLowerCase()} detail ${i}: a sentence of about sixty characters, give or take.`)).join("")).join("");
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "Site map.docx"), zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": `<w:document xmlns:w="w"><w:body>${body}</w:body></w:document>` }));
    const config = testConfig({ cwd: dir, maxContextChars: 32_000 });
    const out = await readFile.run({ path: "Site map.docx" }, { cwd: dir, config });
    expect(out.length).toBeLessThanOrEqual(6_400); // what the agent keeps of a tool result at this budget
    expect(out).not.toContain("characters truncated");
    expect(out).toMatch(/continue with offset=\d+/);
    expect(out).toMatch(/Headings further on: .*\d+ COACHING PAGE.*\d+ READINESS \(chargeable\)/);
    const next = Number(/offset=(\d+)/.exec(out)![1]);
    const lines = out.split("\n").filter((l) => /^\s*\d+\t/.test(l));
    expect(Number(lines.at(-1)!.trim().split("\t")[0])).toBe(next - 1); // ends on a whole line
  });

  test("Excel (.xlsx): sheets as rows, shared strings resolved", async () => {
    const out = await extract(
      "sales.xlsx",
      zip({
        "xl/workbook.xml": `<workbook><sheets><sheet name="Q1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/sharedStrings.xml": `<sst><si><t>Region</t></si><si><t>Total</t></si><si><t>East</t></si></sst>`,
        "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1250.5</v></c></row></sheetData></worksheet>`,
      }),
    );
    expect(out).toContain("Excel workbook, 1 sheet");
    expect(out).toContain("--- sheet Q1 ---");
    expect(out).toContain("Region\tTotal\nEast\t1250.5");
  });

  test("PowerPoint (.pptx): text by slide", async () => {
    const slide = (t: string) => `<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const out = await extract("deck.pptx", zip({ "ppt/presentation.xml": "<p/>", "ppt/slides/slide1.xml": slide("Welcome"), "ppt/slides/slide2.xml": slide("Roadmap 2027") }));
    expect(out).toContain("PowerPoint presentation, 2 slides");
    expect(out).toContain("--- slide 2 ---\nRoadmap 2027");
  });

  test("OpenDocument text and EPUB", async () => {
    const odt = await extract("notes.odt", zip({ mimetype: "application/vnd.oasis.opendocument.text", "content.xml": `<office:document-content><office:body><office:text><text:p>Meeting notes</text:p><text:p>Budget approved</text:p></office:text></office:body></office:document-content>` }));
    expect(odt).toContain("OpenDocument text");
    expect(odt).toContain("Meeting notes\nBudget approved");
    const epub = await extract(
      "book.epub",
      zip({
        mimetype: "application/epub+zip",
        "META-INF/container.xml": `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
        "OEBPS/content.opf": `<package><metadata><dc:title>The Guide</dc:title></metadata><manifest><item id="c1" href="ch1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
        "OEBPS/ch1.xhtml": `<html><body><h1>Chapter one</h1><p>It begins.</p></body></html>`,
      }),
    );
    expect(epub).toContain('EPUB book "The Guide"');
    expect(epub).toContain("Chapter one");
    expect(epub).toContain("It begins.");
  });

  test("archives list their contents: zip, tar.gz", async () => {
    const z = await extract("bundle.zip", zip({ "src/a.ts": "x", "README.md": "hi" }));
    expect(z).toContain("zip archive, 2 entries");
    expect(z).toContain("src/a.ts");
    const tgz = await extract("site.tar.gz", gzipSync(tar({ "index.html": "<p>hi</p>", "css/site.css": "body{}" })));
    expect(tgz).toContain("tar archive (gzip), 2 entries");
    expect(tgz).toContain("css/site.css");
  });

  test("SQLite: tables, columns, row counts and sample rows, opened read-only", async () => {
    const file = path.join(tmpDir(), "app.db");
    const db = openDb(file);
    db.exec("create table users(id integer primary key, email text, plan text); insert into users(email, plan) values ('a@x.io','pro'),('b@x.io','free');");
    db.close();
    const before = fs.statSync(file).mtimeMs;
    const out = await extractDocument(file, fs.readFileSync(file));
    expect(out?.summary).toContain("SQLite database, 1 table");
    expect(out?.text).toContain("users (2 rows): id integer, email text, plan text");
    expect(out?.text).toContain("a@x.io");
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  test("text formats get structure: CSV, notebooks, HTML, RTF, email", async () => {
    const csv = await extract("data.csv", 'name,age\n"Doe, Jane",34\nBob,27\n');
    expect(csv).toContain("CSV, 3 rows × 2 columns: name, age");
    const nb = await extract("analysis.ipynb", JSON.stringify({ cells: [{ cell_type: "markdown", source: ["# Analysis"] }, { cell_type: "code", source: ["print(1+1)"], outputs: [{ output_type: "stream", text: ["2\n"] }] }] }));
    expect(nb).toContain("Jupyter notebook, 2 cells");
    expect(nb).toContain("print(1+1)");
    expect(nb).toContain("2");
    const html = await extract("page.html", "<html><head><title>Docs</title><script>evil()</script></head><body><h1>Install</h1><p>Run the installer.</p></body></html>");
    expect(html).toContain("Install");
    expect(html).not.toContain("evil()");
    const rtf = await extract("letter.rtf", "{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\f0\\fs24 Dear team,\\par Thanks for the work.}");
    expect(rtf).toContain("Dear team,\nThanks for the work.");
    const eml = await extract("mail.eml", "From: Ana <ana@x.io>\r\nTo: bruno@x.io\r\nSubject: Invoice 42\r\nDate: Tue, 20 Oct 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nPlease find the invoice attached.\r\n");
    expect(eml).toContain("Subject: Invoice 42");
    expect(eml).toContain("Please find the invoice attached.");
  });

  test("a private key is never shown", async () => {
    const out = await extract("server.pem", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n");
    expect(out).toContain("private key");
    expect(out).not.toContain("MIIEvQ");
  });

  test("media and binaries are described: PNG, WAV, ELF, unknown", async () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x07, 0x80, 0, 0, 0x04, 0x38, 8, 6]);
    expect(await extract("shot.png", png)).toContain("PNG image, 1920×1080");
    const wav = new Uint8Array(44 + 88200);
    const v = new DataView(wav.buffer);
    wav.set(strToU8("RIFF"), 0);
    wav.set(strToU8("WAVEfmt "), 8);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 2, true);
    v.setUint32(24, 44100, true);
    v.setUint32(28, 44100 * 4, true);
    v.setUint16(32, 4, true);
    v.setUint16(34, 16, true);
    wav.set(strToU8("data"), 36);
    v.setUint32(40, 88200, true);
    expect(await extract("tone.wav", wav)).toMatch(/WAV audio.*44100 Hz.*2 channels.*0\.5 s/);
    const elf = new Uint8Array(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    new DataView(elf.buffer).setUint16(16, 3, true);
    new DataView(elf.buffer).setUint16(18, 0x3e, true);
    expect(await extract("server", elf)).toContain("ELF 64-bit shared object or PIE executable, x86-64");
    const blob = new Uint8Array(200);
    blob.set(strToU8("\x00\x01\x02license key check failed\x00"), 10);
    const unknown = await extract("data.bin", blob);
    expect(unknown).toContain("binary data");
    expect(unknown).toContain("license key check failed");
  });

  test("plain text and code are left to read_file as they are", async () => {
    expect(await extract("main.ts", "export const x = 1;\n")).toBeNull();
    expect(await extract("notes.md", "# Notes\n")).toBeNull();
  });
});

describe("images, with a vision model", () => {
  test("read_file asks the vision model, which gets the image and is told to transcribe the text", async () => {
    const model = fakeModel([{ content: "TypeError: Cannot read properties of undefined (reading 'map') at ProductList.tsx:42" }]);
    const cwd = tmpDir();
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x03, 0x84, 0, 0, 0x01, 0x04, 8, 2]);
    fs.writeFileSync(path.join(cwd, "error.png"), png);
    const config = testConfig({ baseURL: model.baseURL, cwd, visionModel: "vision-model" });
    try {
      const out = await readFile.run({ path: "error.png" }, { cwd, config });
      expect(out).toContain("PNG image, 900×260");
      expect(out).toContain("ProductList.tsx:42");
      const body = model.requests[0] as { model: string; messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[] };
      expect(body.model).toBe("vision-model");
      const parts = body.messages[0].content;
      expect(parts.find((p) => p.type === "text")?.text).toMatch(/transcribe/i);
      expect(parts.find((p) => p.type === "image_url")?.image_url?.url).toMatch(/^data:image\/(png|jpeg);base64,/);
    } finally {
      model.stop();
    }
  });

  test("without a vision model, an image is still described from its header", async () => {
    const cwd = tmpDir();
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10, 8, 6]);
    fs.writeFileSync(path.join(cwd, "dot.png"), png);
    expect(await readFile.run({ path: "dot.png" }, { cwd, config: testConfig({ cwd }) })).toContain("PNG image, 10×10");
  });

  test("a model that sees images gets the image itself, not a vision model's description", async () => {
    const cwd = tmpDir();
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10, 8, 6]);
    fs.writeFileSync(path.join(cwd, "dot.png"), png);
    const attached: ToolImage[] = [];
    // No server behind the vision model: asking it would fail.
    const config = testConfig({ cwd, baseURL: "http://127.0.0.1:9/v1", visionModel: "vision-model" });
    const out = await readFile.run({ path: "dot.png" }, { cwd, config, attach: (i) => attached.push(i) });
    expect(out).toContain("PNG image, 10×10");
    expect(out).toContain("shown to you after the tool results");
    expect(attached).toEqual([{ mime: "image/png", data: Buffer.from(png).toString("base64") }]);
  });
});

describe("read_file with documents and files outside the project", () => {
  test("reads a document from outside the project when the user named it", async () => {
    const downloads = tmpDir();
    const file = path.join(downloads, "invoice.pdf");
    fs.writeFileSync(file, pdf(["Total due: 420 USD"]));
    const cwd = tmpDir();
    expect(needOf(readFile, { path: file }, { cwd, request: `summarize ${file}` })).toBe("none");
    expect(needOf(readFile, { path: file }, { cwd, request: "summarize invoice.pdf from my downloads" })).toBe("none");
    expect(needOf(readFile, { path: file }, { cwd, request: "look around" })).toBe("explicit");
    expect(needOf(readFile, { path: "~/.ssh/id_ed25519" }, { cwd, request: "read ~/.ssh/id_ed25519" })).toBe("explicit");
    const out = await readFile.run({ path: file }, { cwd });
    expect(out).toContain("PDF, 1 page");
    expect(out).toContain("Total due: 420 USD");
  });

  test("a link inside the project still can't lead outside it", async () => {
    const cwd = tmpDir();
    const secret = path.join(tmpDir(), "secret.txt");
    fs.writeFileSync(secret, "s3cr3t");
    fs.symlinkSync(secret, path.join(cwd, "link.txt"));
    await expect(readFile.run({ path: "link.txt" }, { cwd })).rejects.toThrow();
  });
});
