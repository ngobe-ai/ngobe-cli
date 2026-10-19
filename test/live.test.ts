import { describe, expect, test } from "bun:test";
import { securityAdvisories } from "../src/releases/advisories.js";
import { releaseNotes } from "../src/releases/notes.js";
import { latestVersion } from "../src/releases/versions.js";
import { fetchUrl } from "../src/tools/info.js";

// Hits the real official endpoints. Run with: NGOBE_LIVE=1 bun test test/live.test.ts
const live = process.env.NGOBE_LIVE === "1" ? describe : describe.skip;
const VERSION = /^\d+(\.\d+)+/;

live("official sources (network)", () => {
  test.each([
    ["flutter", undefined],
    ["dart", undefined],
    ["node", undefined],
    ["python", undefined],
    ["php", undefined],
    ["go", undefined],
    ["postgresql", undefined],
    ["react", undefined],
    ["laravel", undefined],
    ["django", undefined],
    ["provider", "pub"],
    ["serde", "crates"],
    ["oven-sh/bun", "github"],
  ])("latest %s", async (name, ecosystem) => {
    const info = await latestVersion(name, ecosystem);
    expect(info.stable?.version).toMatch(VERSION);
    expect(info.source).toMatch(/^https:\/\//);
    console.log(`${name}: ${info.stable?.version} (${info.stable?.date ?? "no date"}) ${info.other.map((o) => `${o.channel} ${o.version}`).join(", ")}`);
  }, 60_000);

  test.each([
    ["flutter", undefined, undefined],
    ["oven-sh/bun", "github", undefined],
    ["laravel", undefined, undefined],
    ["django", undefined, undefined],
    ["node", undefined, undefined],
  ])("release notes %s", async (name, ecosystem, version) => {
    const notes = await releaseNotes(name, ecosystem, { version }, {});
    expect(notes.sections.length).toBeGreaterThan(0);
    console.log(`${name}: ${notes.sections[0].title} — ${notes.sections[0].text.length} chars from ${notes.source}`);
  }, 90_000);

  test("breaking changes since a version", async () => {
    const notes = await releaseNotes("oven-sh/bun", "github", { since: "1.3.0" }, {});
    expect(notes.sections.length).toBeGreaterThan(0);
  }, 60_000);

  test("fetch_url won't follow an official site's redirect to another site without approval", async () => {
    // go.dev serves downloads by redirecting to dl.google.com, which isn't on the official list.
    await expect(fetchUrl.run({ url: "https://go.dev/dl/go1.22.0.src.tar.gz" }, { cwd: process.cwd() })).rejects.toThrow("outside the official sites");
  }, 60_000);

  test("advisories for an old lodash", async () => {
    const r = await securityAdvisories("lodash", "npm", "4.17.15");
    expect(r.advisories.length).toBeGreaterThan(0);
  }, 60_000);
});
