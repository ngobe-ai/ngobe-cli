import { execFile } from "node:child_process";
import { childEnv } from "./childEnv.js";

/**
 * Building user interfaces, especially from an image (a screenshot, a mockup, a Figma export).
 * The coding model can't see, so the image reaches it as a blueprint from the vision model plus
 * colors measured from the pixels (vision models guess colors badly), and the request carries
 * guidance on doing it well in the project's own framework.
 */

const BUILD = /\b(?:reproduce|recreate|replicate|rebuild|clone|copy|mimic|implement|build|code|convert|turn|make|create|design|match)\b/i;
const UI = /\b(?:ui|ux|design|screens?|layout|mock-?ups?|wireframes?|pages?|components?|interfaces?|screenshots?|figma|views?|forms?|dashboards?|landing|cards?|navbar|sidebar|modal|look(?:s)? like)\b/i;

/** A request to build or reproduce a user interface ("reproduce this UI from login.png"). */
export function wantsUi(request: string): boolean {
  return BUILD.test(request) && UI.test(request);
}

const IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|heic|tiff?)\b|\b(?:image|screenshot|mock-?up|figma|picture|photo|wireframe)\b/i;

/** Whether the UI is to be built from an image the request points at. */
export function fromImage(request: string): boolean {
  return IMAGE.test(request);
}

/** How to build UI in this project, by its stack. */
function framework(stack: string[]): string {
  const has = (s: string) => stack.includes(s);
  if (has("Flutter")) return "Flutter widgets (a screen widget, colors in a ThemeData or a constants file), not web code";
  if (has("Tailwind") && (has("React") || has("Next.js"))) return "a React component styled with Tailwind classes, in the project's components folder";
  if (has("Next.js") || has("React")) return "a React component with a CSS module, in the project's components folder";
  if (has("Vue")) return "a Vue single-file component";
  if (has("Svelte")) return "a Svelte component";
  if (has("Angular")) return "an Angular component";
  if (has("Laravel")) return `a Blade view${has("Tailwind") ? " with Tailwind classes" : " with its own CSS"}`;
  return "a single HTML file with embedded CSS (no build step; box-sizing: border-box)";
}

const FAITHFULLY =
  "Reproduce it faithfully: the same sections in the same order, the exact texts, each element's alignment (left, centered, right) as in the image, the measured colors as named theme values, similar proportions, a 4/8 px spacing scale, the same type hierarchy, corner radii and shadows.";

/**
 * Guidance that rides on a UI request (not in the system prompt, which stays the same for every
 * request). `sees`: the model is shown images itself; `screenshots`: a browser tool can take one,
 * so a model that sees can check its work against the design.
 */
export function uiHint(stack: string[], image = true, opts: { sees?: boolean; screenshots?: boolean } = {}): string {
  const what = !image
    ? "Building a UI: make it look designed, not generic: a clear layout and type hierarchy, a 4/8 px spacing scale, a small consistent palette with accessible contrast."
    : opts.sees
      ? `Building a UI from an image: you can see the image (it comes with the read_file result; read the file if it isn't shown yet), with its measured colors. ${FAITHFULLY}`
      : `Building a UI from an image: the image was read for you as a blueprint (layout, components, exact texts) with its measured colors. ${FAITHFULLY}`;
  const check = !(opts.sees && opts.screenshots)
    ? ""
    : image
      ? " When it's built, open the page with the browser tools, take a screenshot and compare it with the image: fix every difference (layout, alignment, spacing, colors, texts), then check again until they match."
      : " When it's built, open the page with the browser tools, take a screenshot and look at it: fix what looks broken or off, then check again.";
  return `(${what} Build it as ${framework(stack)}, unless the user asked for something else. Include hover, focus and disabled states, make it responsive and accessible (labels, alt text, contrast), and write complete files with no placeholders or TODOs. Keep each file under ~250 lines: split a big screen into components or files.${check} Then say which file to open or run to see it.)`;
}

/**
 * The colors of an image from ImageMagick's exact histogram ("  9607: (…) #1E1E1E srgb(…)"), most
 * used first. Antialiasing leaves shades close to a real color: those are merged into the more
 * common one. Text colors cover few pixels, so anything above 0.02% counts; at most 10 colors.
 */
export function parsePalette(histogram: string): { hex: string; share: number }[] {
  const rows = [...histogram.matchAll(/^\s*(\d+):.*?(#[0-9A-Fa-f]{6})\b/gm)]
    .map((m) => ({ count: Number(m[1]), hex: m[2].toUpperCase() }))
    .sort((a, b) => b.count - a.count);
  const total = rows.reduce((n, r) => n + r.count, 0);
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const kept: { hex: string; count: number }[] = [];
  // Edge shades sit within ~12 of their color; distinct design colors (a white card on a light
  // gray page) are ~18 or more apart.
  for (const r of rows) {
    const [a, b, c] = rgb(r.hex);
    let near: { hex: string; count: number } | undefined;
    let best = 14;
    for (const k of kept) {
      const [x, y, z] = rgb(k.hex);
      const d = Math.hypot(a - x, b - y, c - z);
      if (d < best) [near, best] = [k, d];
    }
    if (near) near.count += r.count;
    else kept.push({ ...r });
  }
  // The most used colors, plus the strongest ones: on a page full of photos the top ten are grays,
  // and the brand color of the buttons and headings (a small share) was left out (seen live).
  const seen = kept.filter((k) => k.count / total >= 0.0002);
  const chroma = (hex: string) => Math.max(...rgb(hex)) - Math.min(...rgb(hex));
  const strong = seen.filter((k) => chroma(k.hex) >= 80).slice(0, 4);
  const picked = new Set([...seen.filter((k) => !strong.includes(k)).slice(0, 10 - strong.length), ...strong]);
  return seen
    .filter((k) => picked.has(k))
    .map((k) => {
      const share = (k.count / total) * 100;
      return { hex: k.hex, share: share >= 1 ? Math.round(share) : Math.max(0.1, Math.round(share * 10) / 10) };
    });
}

/** The image's main colors, measured with ImageMagick when it is installed (else none). */
export async function measurePalette(file: string): Promise<{ hex: string; share: number }[]> {
  // -sample (nearest pixel), not -resize: averaging would invent colors the design doesn't have.
  const args = [`${file}[0]`, "-sample", "240x240", "-alpha", "off", "-depth", "8", "-format", "%c", "histogram:info:-"];
  for (const cmd of ["magick", "convert"]) {
    const out = await new Promise<string | null>((resolve) => execFile(cmd, args, { timeout: 30_000, env: childEnv() }, (err, stdout) => resolve(err ? null : stdout)));
    if (out) return parsePalette(out);
  }
  return [];
}
