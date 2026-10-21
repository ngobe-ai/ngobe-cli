import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parsePalette, uiHint, wantsUi } from "../src/design.js";
import { readFile } from "../src/tools/readFile.js";
import { fakeModel, testConfig, tmpDir } from "./helpers.js";

describe("building a UI from an image", () => {
  test("recognizes a request to build or reproduce a UI", () => {
    for (const t of [
      "reproduce this UI as a React component ~/Downloads/login.png",
      "build this screen from the screenshot",
      "make the settings page look like this mockup: design.png",
      "implement this design in Flutter /tmp/home.jpg",
      "recreate the dashboard in the image",
      "convert this figma export to HTML and CSS",
    ]) {
      expect(wantsUi(t)).toBe(true);
    }
    for (const t of ["what does this error screenshot say? err.png", "fix the bug in login.tsx", "describe the image", "build the project"]) {
      expect(wantsUi(t)).toBe(false);
    }
  });

  test("the guidance names the project's way of building UI", () => {
    expect(uiHint(["Flutter"])).toContain("Flutter widgets");
    expect(uiHint(["TypeScript", "npm", "Next.js", "React", "Tailwind"])).toContain("Tailwind");
    expect(uiHint(["TypeScript", "npm", "React"])).toContain("React component");
    expect(uiHint([])).toContain("single HTML file");
    expect(uiHint([])).toMatch(/exact texts/);
  });

  test("the palette is the image's real colors, text colors included, without antialiasing shades", () => {
    // ImageMagick's exact histogram of a login mockup (800×600, sampled to 240×180).
    const histogram = [
      [25417, "#F3F4F6"], [15037, "#FFFFFF"], [1491, "#4F46E5"], [514, "#E5E7EB"], [131, "#FCFCFD"], [102, "#111827"],
      [16, "#374151"], [15, "#6B7280"], [12, "#9CA3AF"], [8, "#394353"], [8, "#F8F8F9"], [7, "#6057E7"], [3, "#A1A6B4"],
    ].map(([n, hex]) => `   ${n}: (0,0,0) ${hex} srgb(0,0,0)`).join("\n");
    expect(parsePalette(histogram).map((c) => c.hex)).toEqual(["#F3F4F6", "#FFFFFF", "#4F46E5", "#E5E7EB", "#111827", "#374151", "#6B7280", "#9CA3AF"]);
    expect(parsePalette(histogram)[0].share).toBe(59);
  });

  test("for a UI request, the vision model is asked for a blueprint", async () => {
    const model = fakeModel([{ content: "Login card, centered: heading 'Welcome back' …" }]);
    const cwd = tmpDir();
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x01, 0x90, 0, 0, 0x02, 0x58, 8, 2]);
    fs.writeFileSync(path.join(cwd, "login.png"), png);
    const config = testConfig({ baseURL: model.baseURL, cwd, visionModel: "vision-model" });
    try {
      const out = await readFile.run({ path: "login.png" }, { cwd, config, request: "reproduce this UI as login.html: login.png" });
      expect(out).toContain("Welcome back");
      const body = model.requests[0] as { max_tokens: number; messages: { content: { type: string; text?: string }[] }[] };
      expect(body.messages[0].content.find((p) => p.type === "text")?.text).toMatch(/blueprint/i);
      expect(body.max_tokens).toBeGreaterThanOrEqual(900);
    } finally {
      model.stop();
    }
  });

  // Seen live: a landing page full of stage photos measured as ten grays; its red brand color
  // (buttons, headings) was left out.
  test("strong colors with a small share still make the palette, beside the most used ones", () => {
    const grays = Array.from({ length: 14 }, (_, i) => {
      const v = (20 + i * 17).toString(16).padStart(2, "0").toUpperCase();
      return `  ${5000 - i * 300}: (0,0,0) #${v}${v}${v} srgb(0,0,0)`;
    });
    const histogram = [...grays, "  400: (225,29,42) #E11D2A srgb(225,29,42)", "  90: (37,99,235) #2563EB srgb(37,99,235)"].join("\n");
    const palette = parsePalette(histogram).map((c) => c.hex);
    expect(palette).toHaveLength(10);
    expect(palette).toContain("#E11D2A");
    expect(palette).toContain("#2563EB");
  });
});

