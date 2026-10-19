import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { securityAdvisories } from "../src/releases/advisories.js";
import { installedVersions } from "../src/releases/installed.js";
import { breakingLines, parseSections } from "../src/releases/notes.js";
import { compareVersions, isPrerelease, latestVersion, resolveTarget, versionOf } from "../src/releases/versions.js";
import { checkLatestVersion } from "../src/tools/info.js";
import { tmpDir } from "./helpers.js";

describe("version arithmetic", () => {
  test.each([
    ["3.10.0", "3.9.2", 1],
    ["1.0.0-beta", "1.0.0", -1],
    ["1.0.0-beta.2", "1.0.0-beta.10", -1],
    ["v2.1", "2.1.0", 0],
    ["6.1.5+1", "6.1.5", 0],
    ["go1.27.2", "1.27.10", -1],
    ["6.2a1", "6.1.2", 1],
  ])("compare(%p, %p) has sign %p", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });

  test.each([
    ["3.50.0-0.1.pre", true],
    ["3.14.0-315.1.beta", true],
    ["2.0.0rc1", true],
    ["5.0b3", true],
    ["v13.37.0", false],
    ["1.4.3", false],
    ["6.1.5+1", false],
  ])("isPrerelease(%p) = %p", (v, expected) => expect(isPrerelease(v)).toBe(expected));

  test("versions come out of tags", () => {
    expect(versionOf("bun-v1.4.3")).toBe("1.4.3");
    expect(versionOf("v2.0.0-rc.1")).toBe("2.0.0-rc.1");
    expect(versionOf("b6400")).toBe("6400");
  });

  test("names resolve to their official release source", () => {
    expect(resolveTarget("Flutter")).toEqual({ ecosystem: "flutter", pkg: "flutter" });
    expect(resolveTarget("laravel")).toEqual({ ecosystem: "packagist", pkg: "laravel/framework" });
    expect(resolveTarget("@angular/core")).toEqual({ ecosystem: "npm", pkg: "@angular/core" });
    expect(resolveTarget("requests", "pip")).toEqual({ ecosystem: "pypi", pkg: "requests" });
    expect(() => resolveTarget("left-pad")).toThrow("Pass an ecosystem");
    expect(() => resolveTarget("x", "maven")).toThrow("unknown ecosystem");
  });
});

/** Serve canned official responses by URL prefix instead of hitting the network. */
let realFetch: typeof fetch;
let routes: [string, () => Response][] = [];
beforeEach(() => {
  realFetch = globalThis.fetch;
  routes = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    return route ? route[1]() : new Response("not mocked: " + url, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
const route = (prefix: string, body: unknown, status = 200) => routes.push([prefix, () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })]);

describe("official resolvers (canned responses)", () => {
  test("flutter: current stable and beta from release metadata", async () => {
    route("https://storage.googleapis.com/flutter_infra_release/", {
      current_release: { stable: "aaa", beta: "bbb" },
      releases: [
        { hash: "bbb", channel: "beta", version: "3.50.0-0.1.pre", release_date: "2026-10-14T10:00:00Z" },
        { hash: "aaa", channel: "stable", version: "3.47.7", release_date: "2026-10-08T16:51:21Z" },
        { hash: "old", channel: "stable", version: "3.47.6", release_date: "2026-09-30T00:00:00Z" },
      ],
    });
    const info = await latestVersion("flutter", undefined);
    expect(info.stable).toEqual({ version: "3.47.7", channel: "stable", date: "2026-10-08" });
    expect(info.other).toEqual([{ version: "3.50.0-0.1.pre", channel: "beta", date: "2026-10-14" }]);
    expect(info.source).toContain("releases_linux.json");
    expect(Date.parse(info.checkedAt)).toBeGreaterThan(0);
  });

  test("node: newest Current line, with the newest LTS alongside", async () => {
    route("https://nodejs.org/dist/index.json", [
      { version: "v26.12.0", date: "2026-10-14", lts: false },
      { version: "v24.22.0", date: "2026-10-14", lts: "Krypton" },
    ]);
    const info = await latestVersion("node", undefined);
    expect(info.stable?.version).toBe("26.12.0");
    expect(info.other[0]).toMatchObject({ version: "24.22.0", channel: "lts (Krypton)" });
  });

  test("npm: latest dist-tag; only newer tags are listed", async () => {
    route("https://registry.npmjs.org/-/package/react/dist-tags", { latest: "19.3.1", next: "19.4.0-canary-1", beta: "19.0.0-beta-1", backport: "19.1.10" });
    const info = await latestVersion("react", undefined);
    expect(info.stable?.version).toBe("19.3.1");
    expect(info.other.map((o) => o.channel)).toEqual(["next"]);
  });

  test("packagist: highest stable, skipping release candidates", async () => {
    route("https://repo.packagist.org/p2/laravel/framework.json", {
      packages: {
        "laravel/framework": [
          { version: "v13.0.0-RC1", time: "2026-10-18T00:00:00+00:00" },
          { version: "v12.37.0", time: "2026-10-16T04:59:27+00:00" },
          { version: "v12.36.0", time: "2026-10-13T13:21:00+00:00" },
        ],
      },
    });
    const info = await latestVersion("laravel", undefined);
    expect(info.stable).toMatchObject({ version: "12.37.0", date: "2026-10-16" });
    expect(info.other[0]).toMatchObject({ version: "13.0.0-RC1", channel: "pre-release" });
  });

  test("github: falls back to the highest tag when there are no releases", async () => {
    route("https://api.github.com/repos/acme/tool/releases/latest", { message: "Not Found" }, 404);
    route("https://api.github.com/repos/acme/tool/tags", [{ name: "v1.10.0" }, { name: "v1.9.0" }, { name: "v2.0.0-beta.1" }, { name: "nightly" }]);
    const info = await latestVersion("acme/tool", "github");
    expect(info.stable?.version).toBe("1.10.0");
    expect(info.note).toContain("no GitHub releases");
  });

  test("a missing package is reported as not found, not as a version", async () => {
    await expect(latestVersion("no-such-pkg-xyz", "npm")).rejects.toThrow("was not found in npm");
  });

  test("the tool reports source, check time and the installed comparison", async () => {
    route("https://registry.npmjs.org/-/package/left-pad/dist-tags", { latest: "1.3.0" });
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "node_modules/left-pad"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules/left-pad/package.json"), JSON.stringify({ version: "1.1.0" }));
    const out = await checkLatestVersion.run({ name: "left-pad", ecosystem: "npm", compare_installed: true }, { cwd: dir });
    expect(out).toContain("latest latest release 1.3.0");
    expect(out).toContain("installed: 1.1.0 (node_modules/left-pad/package.json) — behind; latest stable is 1.3.0");
    expect(out).toContain("source: https://registry.npmjs.org/");
    expect(out).toMatch(/checked: \d{4}-\d{2}-\d{2}T/);
  });

  test("OSV advisories with their fixed versions", async () => {
    route("https://api.osv.dev/v1/query", {
      vulns: [
        {
          id: "GHSA-35jh-r3h4-6jhm",
          aliases: ["CVE-2021-23337"],
          summary: "Command Injection in lodash",
          database_specific: { severity: "HIGH" },
          affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }],
        },
      ],
    });
    const r = await securityAdvisories("lodash", "npm", "4.17.15");
    expect(r.advisories[0]).toMatchObject({ id: "GHSA-35jh-r3h4-6jhm", severity: "HIGH", fixed: ["4.17.21"] });
    await expect(securityAdvisories("flutter", undefined, undefined)).rejects.toThrow("no package database");
  });
});

describe("installed versions", () => {
  test("finds FVM pins, lockfile SDK constraints and package versions", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, ".fvmrc"), JSON.stringify({ flutter: "3.44.1" }));
    fs.writeFileSync(path.join(dir, "pubspec.lock"), 'packages:\n  provider:\n    dependency: "direct main"\n    description:\n      name: provider\n    version: "6.1.5"\nsdks:\n  dart: ">=3.9.0 <4.0.0"\n  flutter: ">=3.35.0"\n');
    fs.writeFileSync(path.join(dir, "composer.lock"), JSON.stringify({ packages: [{ name: "laravel/framework", version: "v12.30.0" }] }));
    const flutter = await installedVersions("flutter", dir);
    expect(flutter).toContainEqual({ version: "3.44.1", source: ".fvmrc (FVM pin for this project)" });
    expect(flutter.some((f) => f.version === ">=3.35.0")).toBe(true);
    expect(await installedVersions("provider", dir, "pub")).toEqual([{ version: "6.1.5", source: "pubspec.lock" }]);
    expect(await installedVersions("laravel", dir)).toContainEqual({ version: "12.30.0", source: "composer.lock" });
  });

  test("rejects names that could inject into commands or paths", async () => {
    await expect(installedVersions("x; rm -rf ~", tmpDir())).rejects.toThrow("invalid package name");
  });
});

describe("release notes", () => {
  const md = `# Changelog\n\n## Unreleased\n- wip\n\n## 2.0.0\n- BREAKING: removed the legacy API\n- faster startup\n\n### 2.0.0 details\n- more\n\n## 1.9.0\n- deprecated Foo.bar; use Foo.baz\n- fixes\n`;

  test("splits a changelog into version sections", () => {
    const sections = parseSections(md, "u");
    expect(sections.map((s) => s.version)).toEqual(["2.0.0", "2.0.0", "1.9.0"]);
    expect(sections[0].text).toContain("removed the legacy API");
    expect(sections[0].text).toContain("2.0.0 details"); // subsections stay with their parent
  });

  test("picks out breaking changes and deprecations", () => {
    const [two, , one] = parseSections(md, "u");
    expect(breakingLines(two)).toEqual(["- BREAKING: removed the legacy API"]);
    expect(breakingLines(one)).toEqual(["- deprecated Foo.bar; use Foo.baz"]);
  });
});
