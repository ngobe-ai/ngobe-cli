#!/usr/bin/env node
// Smoke test of the npm build (dist/) under Node, which the Bun test suite doesn't cover:
// the CLI starts, reports the package version, and memory works on node:sqlite.
//
//   npm run build && node scripts/smoke-node.mjs [path to the ngobe executable]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const bin = process.argv[2];
const state = fs.mkdtempSync(path.join(os.tmpdir(), "ngobe-smoke-"));
const env = { ...process.env, NGOBE_STATE_DIR: state, NGOBE_CACHE_DIR: path.join(state, "cache"), NO_COLOR: "1" };
const run = (...args) =>
  execFileSync(bin ?? process.execPath, bin ? args : [new URL("../dist/index.js", import.meta.url).pathname, ...args], { env, encoding: "utf8" });

assert.equal(run("--version").trim(), pkg.version, "--version matches package.json");
assert.match(run("--help"), /Usage: ngobe/, "--help prints usage");
assert.match(run("memory", "list"), /enabled/, "memory opens (node:sqlite)");
run("learn"); // reads run stats and failure clusters
assert.ok(fs.existsSync(path.join(state, "ngobe.db")), "memory database created");
assert.match(run("config"), /"maxTurns": 40/, "config prints");
console.log(`smoke ok: ngobe ${pkg.version} on ${bin ? path.basename(bin) : `node ${process.version}`}`);
