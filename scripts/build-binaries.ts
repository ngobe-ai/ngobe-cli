#!/usr/bin/env bun
/**
 * Build standalone ngobe executables (Bun runtime embedded, no Node needed) and package
 * them for GitHub Releases:
 *
 *   dist-bin/ngobe-<os>-<arch>.tar.gz   (contains the `ngobe` binary)
 *   dist-bin/SHA256SUMS
 *
 * Asset names carry no version, so ".../releases/latest/download/ngobe-linux-x64.tar.gz"
 * always points at the newest release (install.sh relies on this).
 *
 *   bun scripts/build-binaries.ts                  # every target
 *   bun scripts/build-binaries.ts darwin-arm64     # only these
 *
 * NGOBE_BIN_OUT sets the output directory; NGOBE_RELEASE_VERSION overrides the embedded version.
 */
import type { BunPlugin } from "bun";
import { $ } from "bun";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pkg from "../package.json";

// linux-x64-baseline runs on x64 CPUs without AVX2 (old hardware, and VPS hosts that hide it).
export const TARGETS = ["linux-x64", "linux-x64-baseline", "linux-arm64", "darwin-x64", "darwin-arm64"];
const OUT = process.env.NGOBE_BIN_OUT ?? "dist-bin";
// The release workflow checks the tag matches package.json; the override is for testing updates.
const VERSION = process.env.NGOBE_RELEASE_VERSION ?? pkg.version;

// Ink imports React DevTools only when DEV=true, but a single-file bundle evaluates the import
// at startup, and the package isn't installed. Replace it with a no-op.
const stubDevtools: BunPlugin = {
  name: "stub-react-devtools",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "react-devtools-core", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default { initialize() {}, connectToDevTools() {} };", loader: "js" }));
  },
};

const targets = process.argv.slice(2).length ? process.argv.slice(2) : TARGETS;
for (const t of targets) if (!TARGETS.includes(t)) throw new Error(`unknown target ${t}; use one of ${TARGETS.join(", ")}`);
fs.mkdirSync(OUT, { recursive: true });

for (const target of targets) {
  const name = `ngobe-${target}`;
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const result = await Bun.build({
    entrypoints: ["src/index.ts"],
    compile: { target: `bun-${target}` as Bun.Build.Target, outfile: path.join(dir, "ngobe") },
    minify: true,
    sourcemap: "none",
    define: { NGOBE_BUILD_VERSION: JSON.stringify(VERSION) },
    plugins: [stubDevtools],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  if (target.startsWith("darwin")) {
    // Cross-compiling appends the app to an already-signed runtime, which breaks the signature
    // (Apple Silicon refuses to run such binaries). Re-sign ad hoc; codesign only exists on macOS.
    if (process.platform === "darwin") await $`codesign --force --sign - ${path.join(dir, "ngobe")}`.quiet();
    else console.warn(`warning: ${name} is not re-signed (build it on macOS for a valid signature)`);
  }
  await $`tar -czf ${path.join(OUT, `${name}.tar.gz`)} -C ${dir} ngobe`;
  const size = fs.statSync(path.join(dir, "ngobe")).size / 1024 ** 2;
  console.log(`built ${name} (${size.toFixed(0)} MB)`);
}

// Checksums for every archive present (CI builds targets on different runners, then sums once).
const archives = fs.readdirSync(OUT).filter((f) => /^ngobe-.+\.tar\.gz$/.test(f)).sort();
const sums = archives.map((f) => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(OUT, f))).digest("hex")}  ${f}`);
fs.writeFileSync(path.join(OUT, "SHA256SUMS"), sums.join("\n") + "\n");
console.log(`wrote ${OUT}/SHA256SUMS (${archives.length} archives)`);
