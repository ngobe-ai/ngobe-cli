import fs from "node:fs/promises";
import path from "node:path";

export type CommandKind = "test" | "build" | "lint" | "typecheck" | "format";

export interface ProjectInfo {
  /** e.g. ["TypeScript", "bun", "React"] */
  stack: string[];
  commands: Partial<Record<CommandKind, string>>;
}

/** The project's real test/build/lint commands, read from its manifests. Nothing is run. */
export async function detectProject(cwd: string): Promise<ProjectInfo> {
  const exists = (f: string) => fs.access(path.join(cwd, f)).then(() => true, () => false);
  const read = (f: string) => fs.readFile(path.join(cwd, f), "utf8").catch(() => null);
  const info: ProjectInfo = { stack: [], commands: {} };
  const set = (k: CommandKind, v: string) => {
    info.commands[k] ??= v;
  };

  const pkg = await read("package.json");
  if (pkg) {
    let json: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try {
      json = JSON.parse(pkg);
    } catch {
      // unparseable manifest: still a JS project
    }
    const pm = (await exists("bun.lock")) || (await exists("bun.lockb")) ? "bun" : (await exists("pnpm-lock.yaml")) ? "pnpm" : (await exists("yarn.lock")) ? "yarn" : "npm";
    const run = (s: string) => (pm === "npm" && s === "test" ? "npm test" : `${pm} run ${s}`);
    const scripts = json.scripts ?? {};
    const scriptFor: [CommandKind, string[]][] = [
      ["test", ["test"]],
      ["build", ["build"]],
      ["lint", ["lint"]],
      ["typecheck", ["typecheck", "type-check", "check-types", "tsc"]],
      ["format", ["format", "fmt"]],
    ];
    for (const [kind, names] of scriptFor) {
      const s = names.find((n) => scripts[n]);
      if (s) set(kind, run(s));
    }
    const deps = { ...json.dependencies, ...json.devDependencies };
    info.stack.push((await exists("tsconfig.json")) || deps.typescript ? "TypeScript" : "JavaScript", pm);
    const frameworks: [string, string][] = [
      ["next", "Next.js"],
      ["react", "React"],
      ["vue", "Vue"],
      ["svelte", "Svelte"],
      ["@angular/core", "Angular"],
      ["express", "Express"],
      ["@nestjs/core", "NestJS"],
      ["vite", "Vite"],
      ["tailwindcss", "Tailwind"],
      ["ink", "Ink"],
    ];
    for (const [dep, label] of frameworks) if (deps[dep]) info.stack.push(label);
  }

  const pubspec = await read("pubspec.yaml");
  if (pubspec) {
    const flutter = /sdk:\s*flutter\b/.test(pubspec);
    info.stack.push(flutter ? "Flutter" : "Dart");
    set("test", flutter ? "flutter test" : "dart test");
    set("lint", flutter ? "flutter analyze" : "dart analyze");
    set("format", "dart format .");
  }

  const composer = await read("composer.json");
  if (composer) {
    info.stack.push("PHP");
    const scripts = (() => {
      try {
        return (JSON.parse(composer) as { scripts?: Record<string, unknown> }).scripts ?? {};
      } catch {
        return {};
      }
    })();
    if (await exists("artisan")) {
      info.stack.push("Laravel");
      set("test", "php artisan test");
    }
    if (scripts.test) set("test", "composer test");
    if (await exists("vendor/bin/phpunit")) set("test", "vendor/bin/phpunit");
    if (await exists("vendor/bin/pint")) set("format", "vendor/bin/pint");
    if (await exists("vendor/bin/phpstan")) set("lint", "vendor/bin/phpstan analyse");
  }

  const pyproject = await read("pyproject.toml");
  if (pyproject !== null || (await exists("setup.py")) || (await exists("requirements.txt"))) {
    info.stack.push("Python");
    const py = pyproject ?? "";
    if (/pytest/.test(py) || (await exists("pytest.ini")) || (await exists("conftest.py")) || (await exists("tests"))) set("test", "python -m pytest");
    if (/ruff/.test(py)) {
      set("lint", "ruff check .");
      set("format", "ruff format .");
    }
    if (/mypy/.test(py)) set("typecheck", "mypy .");
  }

  if (await exists("Cargo.toml")) {
    info.stack.push("Rust");
    set("test", "cargo test");
    set("build", "cargo build");
    set("lint", "cargo clippy");
    set("format", "cargo fmt");
  }

  if (await exists("go.mod")) {
    info.stack.push("Go");
    set("test", "go test ./...");
    set("build", "go build ./...");
    set("lint", "go vet ./...");
    set("format", "gofmt -l -w .");
  }

  const makefile = await read("Makefile");
  if (makefile) {
    if (/^test:/m.test(makefile)) set("test", "make test");
    if (/^build:/m.test(makefile)) set("build", "make build");
  }
  return info;
}
