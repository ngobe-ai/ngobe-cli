#!/usr/bin/env bun
/**
 * Release a new version: bump package.json, run the checks a release needs, then commit, tag
 * and push. The tag starts .github/workflows/release.yml (binaries, GitHub Release, Homebrew,
 * and npm when NPM_PUBLISH allows it).
 *
 *   bun run release patch "faster answers"   # 0.3.9 → 0.3.10, "release: 0.3.10 — faster answers"
 *   bun run release minor                    # 0.3.9 → 0.4.0
 *   bun run release 1.0.0 "first stable"
 *   bun run release patch --dry-run          # the checks only: nothing committed, tagged or pushed
 *
 * Refuses unless on main, clean and up to date with origin/main. The checks are tests,
 * typecheck, build and the Node smoke test (v0.3.6 failed CI on Node only).
 */
import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";

// x.y.z, or a pre-release x.y.z-rc.1 (a GitHub pre-release, published to npm under "next").
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** The version after `current`: a patch, minor or major bump, or an explicit newer version. */
export function nextVersion(current: string, bump: string): string {
  const cur = SEMVER.exec(current);
  if (!cur) throw new Error(`package.json's version ${current} is not x.y.z`);
  const [major, minor, patch] = cur.slice(1, 4).map(Number);
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  if (bump === "major") return `${major + 1}.0.0`;
  const want = SEMVER.exec(bump.replace(/^v/, ""));
  if (!want) throw new Error(`expected patch, minor, major or a version like 1.2.3, not "${bump}"`);
  const [a, b, c] = want.slice(1, 4).map(Number);
  // At the same x.y.z, a release follows its pre-releases, and rc.2 follows rc.1.
  const [pre, wantPre] = [cur[4], want[4]];
  const preNewer = !pre ? false : !wantPre ? true : wantPre.localeCompare(pre, undefined, { numeric: true }) > 0;
  const newer = a !== major ? a > major : b !== minor ? b > minor : c !== patch ? c > patch : preNewer;
  if (!newer) throw new Error(`${want[0]} must be newer than ${current}`);
  return want[0];
}

/** "release: 0.3.9 — finishes questions …", like the releases before it. */
export function releaseMessage(version: string, summary: string): string {
  return summary.trim() ? `release: ${version} — ${summary.trim()}` : `release: ${version}`;
}

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const [bump, ...words] = args.filter((a) => a !== "--dry-run");
  if (!bump) fail('usage: bun run release <patch|minor|major|x.y.z> ["summary"] [--dry-run]');

  const root = path.resolve(import.meta.dir, "..");
  $.cwd(root);
  const pkgFile = path.join(root, "package.json");
  const original = fs.readFileSync(pkgFile, "utf8");
  const current = (JSON.parse(original) as { version: string }).version;
  let version = "";
  try {
    version = nextVersion(current, bump);
  } catch (err) {
    fail((err as Error).message);
  }
  const tag = `v${version}`;
  const message = releaseMessage(version, words.join(" "));

  const branch = (await $`git branch --show-current`.text()).trim();
  if (branch !== "main") fail(`on "${branch}": releases are tagged from main`);
  if ((await $`git status --porcelain`.text()).trim()) fail("there are uncommitted changes: commit or stash them first");
  await $`git fetch --quiet --tags origin main`;
  const behind = (await $`git rev-list --count HEAD..origin/main`.text()).trim();
  if (behind !== "0") fail(`main is ${behind} commit(s) behind origin/main: pull first`);
  if ((await $`git tag --list ${tag}`.text()).trim()) fail(`${tag} already exists`);

  console.log(`Releasing ${current} → ${version}${dry ? " (dry run)" : ""}: ${message}`);
  const bumped = original.replace(`"version": "${current}"`, `"version": "${version}"`);
  if (bumped === original) fail(`couldn't find "version": "${current}" in package.json`);
  fs.writeFileSync(pkgFile, bumped);
  const checks: [string, () => Promise<unknown>][] = [
    ["tests", () => $`bun test`],
    ["typecheck", () => $`npx tsc --noEmit`],
    ["build", () => $`bun run build`],
    ["Node smoke test", () => $`node scripts/smoke-node.mjs`],
  ];
  for (const [label, run] of checks) {
    console.log(`\n▸ ${label}`);
    try {
      await run();
    } catch {
      fs.writeFileSync(pkgFile, original);
      fail(`${label} failed; package.json is back at ${current}, nothing was committed`);
    }
  }
  if (dry) {
    fs.writeFileSync(pkgFile, original);
    console.log(`\nDry run passed. Without --dry-run: commit "${message}", tag ${tag}, push main and the tag.`);
    return;
  }

  await $`git add package.json`;
  await $`git commit -q -m ${message}`;
  await $`git tag -a ${tag} -m ${message}`;
  await $`git push -q origin main`;
  await $`git push -q origin ${tag}`;
  console.log(`\nPushed ${tag}. The release workflow now builds the binaries, the GitHub Release and the Homebrew formula. Follow it with:`);
  console.log(`  gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')`);
}

if (import.meta.main) await main();
