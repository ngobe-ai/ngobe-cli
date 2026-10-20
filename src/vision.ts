import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childEnv } from "./childEnv.js";
import type { Config } from "./config.js";

/**
 * Images for a coding model that can't see: a small vision model on the same server (visionModel,
 * NGOBE_VISION_MODEL) transcribes the text in the image and says what it shows, and that text is
 * what the coding model reads. PNG and JPEG are sent as they are when small; anything else, or
 * anything big, is converted to a JPEG of at most 1,280 pixels first (sips on macOS, ImageMagick
 * elsewhere), since the server decodes only common formats and the gateway limits request size.
 */

const PROMPT =
  "You are helping a software developer who can't see this image. First, transcribe every piece of visible text exactly as written (code, error messages, file paths with line numbers, UI labels, numbers), keeping line breaks. Then, in two to four sentences, describe what the image shows (the kind of screen, diagram or photo, layout, anything notable).";
const MAX_SIDE = 1280;
const MAX_DIRECT = 1_500_000;

/** What the vision model says about the image, or null when it can't be sent. Throws on server errors. */
export async function describeImage(config: Config, file: string, buf: Uint8Array, signal?: AbortSignal): Promise<string | null> {
  if (!config.visionModel) return null;
  const image = await prepare(file, buf);
  if (!image) return null;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey && config.apiKey !== "not-needed") headers.authorization = `Bearer ${config.apiKey}`;
  const res = await fetch(`${config.baseURL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.visionModel,
      stream: false,
      max_tokens: 700,
      temperature: 0.1,
      messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data.toString("base64")}` } }] }],
    }),
    // A CPU server loads the vision model on first use: allow minutes, not Bun's default 300 s cut-off.
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
    timeout: false,
  } as RequestInit);
  if (!res.ok) throw new Error(`vision model ${config.visionModel}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content?.trim() || null;
}

/** The image as the server can take it: PNG/JPEG as is when small, else a converted JPEG. */
async function prepare(file: string, buf: Uint8Array): Promise<{ mime: string; data: Buffer } | null> {
  const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if ((png || jpeg) && buf.length <= MAX_DIRECT) return { mime: png ? "image/png" : "image/jpeg", data: Buffer.from(buf) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ngobe-image-"));
  const out = path.join(dir, "image.jpg");
  try {
    const converted =
      (process.platform === "darwin" && (await run("sips", ["-Z", String(MAX_SIDE), "-s", "format", "jpeg", file, "--out", out]))) ||
      (await run("magick", [`${file}[0]`, "-resize", `${MAX_SIDE}x${MAX_SIDE}>`, "-quality", "85", out])) ||
      (await run("convert", [`${file}[0]`, "-resize", `${MAX_SIDE}x${MAX_SIDE}>`, "-quality", "85", out]));
    if (converted && fs.existsSync(out)) return { mime: "image/jpeg", data: fs.readFileSync(out) };
    // No converter: a PNG or JPEG still goes as it is if the gateway can take it.
    return (png || jpeg) && buf.length <= 3_000_000 ? { mime: png ? "image/png" : "image/jpeg", data: Buffer.from(buf) } : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 60_000, env: childEnv() }, (err) => resolve(!err)));
}
