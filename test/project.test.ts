import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { detectProject } from "../src/project.js";
import { tmpDir } from "./helpers.js";

function project(files: Record<string, string>): string {
  const dir = tmpDir();
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe("project detection", () => {
  test("bun project with scripts", async () => {
    const dir = project({
      "package.json": JSON.stringify({ scripts: { test: "bun test", build: "tsc", typecheck: "tsc --noEmit" }, dependencies: { react: "19" } }),
      "bun.lock": "",
      "tsconfig.json": "{}",
    });
    expect(await detectProject(dir)).toEqual({
      stack: ["TypeScript", "bun", "React"],
      commands: { test: "bun run test", build: "bun run build", typecheck: "bun run typecheck" },
    });
  });

  test("npm uses npm test", async () => {
    expect((await detectProject(project({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) }))).commands.test).toBe("npm test");
  });

  test("flutter app", async () => {
    const info = await detectProject(project({ "pubspec.yaml": "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n" }));
    expect(info).toEqual({ stack: ["Flutter"], commands: { test: "flutter test", lint: "flutter analyze", format: "dart format ." } });
  });

  test("laravel app", async () => {
    const info = await detectProject(project({ "composer.json": "{}", artisan: "" }));
    expect(info.stack).toEqual(["PHP", "Laravel"]);
    expect(info.commands.test).toBe("php artisan test");
  });

  test("python with pytest and ruff", async () => {
    const info = await detectProject(project({ "pyproject.toml": "[tool.pytest.ini_options]\n[tool.ruff]\n" }));
    expect(info.commands).toMatchObject({ test: "python -m pytest", lint: "ruff check ." });
  });

  test("go, rust and make", async () => {
    expect((await detectProject(project({ "go.mod": "module x" }))).commands.test).toBe("go test ./...");
    expect((await detectProject(project({ "Cargo.toml": "" }))).commands.lint).toBe("cargo clippy");
    expect((await detectProject(project({ Makefile: "test:\n\techo ok\n" }))).commands.test).toBe("make test");
  });

  test("nothing to detect", async () => {
    expect(await detectProject(tmpDir())).toEqual({ stack: [], commands: {} });
  });
});
