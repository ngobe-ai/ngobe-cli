import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createProject, folderName, frameworkIn, generatorCommands, generatorFor, scaffoldArgs } from "../src/tools/createProject.js";
import type { ToolContext } from "../src/types.js";
import { tmpDir } from "./helpers.js";

const PATH = process.env.PATH;
afterEach(() => {
  process.env.PATH = PATH;
});

/** A fake command on the PATH (generators are slow and need the network; their real runs are in docs/status.md). */
function fakeCommand(name: string, script: string): void {
  const bin = tmpDir("ngobe-bin-");
  fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${script}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
}

function context(cwd: string) {
  const entered: { dir: string; starter: string[] }[] = [];
  const ctx: ToolContext = { cwd, files: new Map(), enterProject: (dir, starter) => entered.push({ dir, starter }) };
  return { ctx, entered };
}

describe("create_project", () => {
  test("each generator runs without questions: every choice is a flag", () => {
    expect(generatorCommands({ framework: "nextjs", name: "cote-web" })).toEqual([
      'npx -y create-next-app@latest cote-web --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes --no-agent-feedback',
    ]);
    expect(generatorCommands({ framework: "Next.js", name: "Site", typescript: false, tailwind: false })[0]).toContain("site --js --no-tailwind");
    expect(generatorCommands({ framework: "react", name: "app" })).toEqual([
      "npx -y create-vite@latest app --template react-ts --no-interactive --no-immediate",
      "cd app && npm install && npm install tailwindcss @tailwindcss/vite",
    ]);
    // "--add tailwindcss" alone asks about plugins, and exits 0 having made nothing.
    expect(generatorCommands({ framework: "svelte", name: "kit" })[0]).toContain('--add tailwindcss="plugins:none" --install npm');
    expect(generatorCommands({ framework: "django", name: "shop" })).toEqual(["mkdir shop && cd shop && uv init --bare && uv add django && uv run django-admin startproject config . && git init -q"]);
    expect(generatorCommands({ framework: "fastapi", name: "api" })).toEqual(["uv init api && cd api && uv add 'fastapi[standard]'"]);
    expect(generatorCommands({ framework: "golang", name: "svc" })).toEqual(["mkdir svc && cd svc && go mod init example.com/svc && git init -q"]);
    expect(generatorCommands({ framework: "rust", name: "cli" })).toEqual(["cargo new cli"]);
    expect(generatorCommands({ framework: "flutter", name: "my-app" })).toEqual(["flutter create --org com.example my_app"]); // Dart package names
    expect(generatorCommands({ framework: "laravel", name: "blog" })).toEqual(["composer create-project laravel/laravel blog --no-interaction --prefer-dist"]);
    // Any other kind of project: a folder with git, and the model writes the files.
    expect(generatorFor("c++ with cmake")).toBeNull();
    expect(generatorCommands({ framework: "c++ with cmake", name: "engine" })).toEqual(["mkdir engine && cd engine && git init -q"]);
  });

  test("folder names are one plain name in the working folder", () => {
    expect(folderName("Cote Web")).toBe("cote-web");
    for (const bad of ["../up", "/abs", "a/b", "", "-flag", "x;rm -rf ~"]) expect(() => folderName(bad)).toThrow(/can't be a project folder/);
  });

  test("the generator a request names, in any language", () => {
    expect(frameworkIn("create a web page using nextjs and tailwindcss")).toBe("nextjs");
    expect(frameworkIn("a React dashboard")).toBe("vite-react");
    expect(frameworkIn("an API in FastAPI")).toBe("fastapi");
    expect(frameworkIn("a REST service with Spring Boot")).toBe("spring-boot");
    expect(frameworkIn("a CLI in Rust")).toBe("rust");
    expect(frameworkIn("a golang worker")).toBe("go");
    expect(frameworkIn("an ASP.NET api")).toBe("aspnet");
    expect(frameworkIn("a C# console app")).toBe("dotnet");
    expect(frameworkIn("go ahead and fix it")).toBeNull(); // "go" the word is not Go
    expect(frameworkIn("add a next button")).toBeNull();
  });

  test("a generator's command in a reply is read as create_project arguments", () => {
    // Seen live from the 7B, in a code block for the user.
    expect(scaffoldArgs("npx create-next-app@latest cote-web\ncd cote-web\nnpm install tailwindcss\nnpx tailwindcss init -p")).toEqual({ framework: "nextjs", name: "cote-web", tailwind: true });
    expect(scaffoldArgs("npx create-next-app@latest my-app --js")).toEqual({ framework: "nextjs", name: "my-app", typescript: false });
    expect(scaffoldArgs("npm create vite@latest web -- --template vue-ts")).toEqual({ framework: "vite-vue", name: "web" });
    expect(scaffoldArgs("npm create vite@latest web -- --template react")).toEqual({ framework: "vite-react", name: "web", typescript: false });
    expect(scaffoldArgs("flutter create --org com.acme --platforms ios,android shop_app")).toEqual({ framework: "flutter", name: "shop_app" });
    expect(scaffoldArgs("composer create-project --prefer-dist laravel/laravel blog")).toEqual({ framework: "laravel", name: "blog" });
    expect(scaffoldArgs("cargo new --lib parser")).toEqual({ framework: "rust-lib", name: "parser" });
    expect(scaffoldArgs("dotnet new webapi -o Orders")).toEqual({ framework: "aspnet", name: "Orders" });
    // Not a generator, or in the current folder: bash as written.
    expect(scaffoldArgs("npm install && npm run build")).toBeNull();
    expect(scaffoldArgs("flutter create .")).toBeNull();
  });

  test("runs the generator, then works in the new project with its starter files replaceable", async () => {
    // A stand-in create-next-app: makes the folder like the real one (checked in a real run).
    fakeCommand("npx", 'mkdir -p "$3/src/app" && echo \'{"name":"x"}\' > "$3/package.json" && mkdir "$3/node_modules" && echo "export default function Home() {}" > "$3/src/app/page.tsx" && echo "@import \\"tailwindcss\\";" > "$3/src/app/globals.css" && echo ok');
    const cwd = tmpDir();
    const { ctx, entered } = context(cwd);
    const out = await createProject.run({ framework: "nextjs", name: "cote-web" }, ctx);
    const dir = path.join(cwd, "cote-web");
    expect(out).toStartWith("Created cote-web/: a Next.js project with TypeScript, Tailwind CSS, made by its official generator. The working folder is now cote-web/");
    expect(out).toContain("no tailwind.config.js");
    expect(out).toContain("npm run build");
    expect(out).toContain("Files: package.json, src/app/globals.css, src/app/page.tsx");
    expect(out).toContain("SOLID and YAGNI");
    expect(out).toContain("Replace these starter files whole with write_file (no need to read them first): src/app/page.tsx, src/app/globals.css");
    expect(entered).toEqual([{ dir, starter: [path.join(dir, "src/app/page.tsx"), path.join(dir, "src/app/globals.css")] }]);
    expect(ctx.files?.has(path.join(dir, "src/app/page.tsx"))).toBe(true);
  });

  test("a generator that exits 0 having made nothing is a failure, not a project", async () => {
    // sv create with an add-on option missing: asks, can't, exits 0.
    fakeCommand("npx", 'echo "◆  Which plugins would you like to add?"');
    const { ctx, entered } = context(tmpDir());
    await expect(createProject.run({ framework: "sveltekit", name: "kit" }, ctx)).rejects.toThrow(/kit\/ has no package.json: it didn't create the project/);
    expect(entered).toEqual([]);
  });

  test("a failing generator reports the end of its output", async () => {
    fakeCommand("npx", 'echo "npm error network request failed"; exit 1');
    const { ctx } = context(tmpDir());
    await expect(createProject.run({ framework: "nextjs", name: "web" }, ctx)).rejects.toThrow(/failed:\n[\s\S]*npm error network request failed/);
  });

  test("an install that failed without saying so is retried, and reported if it fails again", async () => {
    fakeCommand("npx", 'mkdir -p "$4" && echo \'{"name":"x"}\' > "$4/package.json" && echo "Packages installation failed!"');
    fakeCommand("npm", 'echo "npm error Cannot read properties of null"; exit 1');
    const { ctx } = context(tmpDir());
    const out = await createProject.run({ framework: "nestjs", name: "api" }, ctx);
    expect(out).toContain("npm install failed, so dependencies are missing");
  });

  test("anything else gets a folder with git, and the model writes the files", async () => {
    const cwd = tmpDir();
    const { ctx, entered } = context(cwd);
    const out = await createProject.run({ framework: "C++ with CMake", name: "engine" }, ctx);
    expect(out).toContain('Created engine/ with git (no generator is known for "C++ with CMake")');
    expect(out).toContain("manifest or build file first");
    expect(fs.existsSync(path.join(cwd, "engine", ".git"))).toBe(true);
    expect(entered[0].dir).toBe(path.join(cwd, "engine"));
  });

  test("an existing project folder is entered, not overwritten; another folder of that name is refused", async () => {
    const cwd = tmpDir();
    fs.mkdirSync(path.join(cwd, "site"));
    fs.writeFileSync(path.join(cwd, "site", "package.json"), "{}");
    const { ctx, entered } = context(cwd);
    expect(await createProject.run({ framework: "nextjs", name: "site" }, ctx)).toStartWith("site/ already exists, so nothing was created");
    expect(entered[0].dir).toBe(path.join(cwd, "site"));
    fs.mkdirSync(path.join(cwd, "notes"));
    fs.writeFileSync(path.join(cwd, "notes", "todo.txt"), "x");
    await expect(createProject.run({ framework: "nextjs", name: "notes" }, ctx)).rejects.toThrow(/already exists and isn't empty/);
  });

  test("a toolchain that isn't installed is said plainly, before running anything", async () => {
    process.env.PATH = tmpDir("ngobe-empty-"); // nothing on the PATH
    const { ctx } = context(tmpDir());
    await expect(createProject.run({ framework: "laravel", name: "blog" }, ctx)).rejects.toThrow(/needs composer, which isn't installed here/);
  });
});
