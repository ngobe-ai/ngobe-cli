import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { listFiles } from "../src/tools/files.js";
import { glob } from "../src/tools/glob.js";
import { projectOverview } from "../src/tools/overview.js";
import { tmpDir } from "./helpers.js";

function write(root: string, files: Record<string, string>) {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
}

/**
 * Shaped like the project the agent failed on: a Flutter app whose generated docs folder
 * (1,600 files) buried lib/ in a 200-path glob result, and build output that is gitignored.
 */
function flutterApp(root: string) {
  write(root, {
    "pubspec.yaml": "name: hype\ndescription: A music player for Android and iOS.\nenvironment:\n  sdk: ^3.5.0\ndependencies:\n  flutter:\n    sdk: flutter\n  just_audio: ^0.9.0\n  provider: ^6.0.0\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n",
    "README.md": "# Hype\n\n[![build](https://x/badge.svg)](https://x)\n\nHype streams and downloads music, with offline playlists.\n",
    "lib/main.dart": "void main() {}\n",
    "lib/services/player.dart": "",
    "lib/services/library.dart": "",
    "lib/screens/home.dart": "",
    "test/player_test.dart": "",
    ".gitignore": "build/\n.dart_tool/\n",
    "build/app.apk.txt": "",
    ".dart_tool/cache.json": "",
  });
  for (let i = 0; i < 150; i++) write(root, { [`graft/nodes/n${i}.md`]: "" });
  execFileSync("git", ["init", "-q"], { cwd: root });
}

describe("listing files", () => {
  test("leaves out gitignored files and .git", async () => {
    const root = tmpDir();
    flutterApp(root);
    const files = await listFiles(root);
    expect(files).toContain("lib/main.dart");
    expect(files).toContain("pubspec.yaml");
    expect(files.some((f) => f.startsWith("build/") || f.startsWith(".dart_tool/") || f.startsWith(".git/"))).toBe(false);
  });
});

describe("glob", () => {
  test("shows at most 100 paths, and says where the rest are", async () => {
    const root = tmpDir();
    flutterApp(root);
    const out = await glob.run({ pattern: "**/*" }, { cwd: root });
    const paths = out.split("\n").filter((l) => /^[\w.-]+\//.test(l) || /^[\w.-]+$/.test(l));
    expect(paths.length).toBeLessThanOrEqual(100);
    expect(out).toMatch(/1\d\d files match/);
    expect(out).toContain("graft/nodes/ (150)");
    expect(out).toContain("lib/");
    expect(out).not.toContain("build/app.apk.txt");
  });

  test("a small result is just the paths, newest first", async () => {
    const root = tmpDir();
    flutterApp(root);
    const old = new Date("2026-01-01T00:00:00Z");
    for (const f of ["lib/main.dart", "lib/services/player.dart", "lib/services/library.dart"]) fs.utimesSync(path.join(root, f), old, old);
    fs.utimesSync(path.join(root, "lib/screens/home.dart"), new Date(), new Date(Date.now() + 60_000));
    const out = await glob.run({ pattern: "lib/**/*.dart" }, { cwd: root });
    expect(out.split("\n")).toEqual(["lib/screens/home.dart", "lib/main.dart", "lib/services/library.dart", "lib/services/player.dart"]);
  });

  test("patterns keep their meaning: *.dart is the top level only", async () => {
    const root = tmpDir();
    write(root, { "a.dart": "", "lib/b.dart": "" });
    expect(await glob.run({ pattern: "*.dart" }, { cwd: root })).toBe("a.dart");
  });
});

describe("project_overview", () => {
  test("a project in one call: stack, description, folders, dependencies, README", async () => {
    const root = tmpDir();
    flutterApp(root);
    const out = await projectOverview.run({}, { cwd: root });
    expect(out).toContain("Flutter");
    expect(out).toContain("hype");
    expect(out).toContain("A music player for Android and iOS.");
    expect(out).toContain("flutter test");
    expect(out).toMatch(/lib\/?\s.*4/); // lib holds 4 files
    expect(out).toContain("services/ (2)");
    expect(out).toContain("just_audio");
    expect(out).toContain("Hype streams and downloads music");
    expect(out).not.toContain("badge.svg");
    expect(out).not.toContain("build/");
    expect(out.length).toBeLessThan(3_000);
  });

  test("a folder of projects lists each one with its stack", async () => {
    const root = tmpDir();
    flutterApp(path.join(root, "hype"));
    write(root, {
      "site/package.json": JSON.stringify({ name: "site", description: "Marketing site", dependencies: { next: "15.0.0", react: "19.0.0" } }),
      "notes/todo.txt": "",
    });
    const out = await projectOverview.run({}, { cwd: root });
    expect(out).toMatch(/hype\/ .*Flutter.*A music player/);
    expect(out).toMatch(/site\/ .*Next\.js.*Marketing site/);
    expect(out).toContain("notes/");
  });

  test("a subfolder by path, and nothing outside the project", async () => {
    const root = tmpDir();
    flutterApp(path.join(root, "hype"));
    expect(await projectOverview.run({ path: "hype" }, { cwd: root })).toContain("A music player");
    await expect(projectOverview.run({ path: "../" }, { cwd: root })).rejects.toThrow();
  });
});
