import fs from "node:fs";
import path from "node:path";
import type { Args, Tool, ToolContext } from "../types.js";
import { bash } from "./bash.js";
import { hashText, reqStr } from "./util.js";

/**
 * New projects of any kind. Small models know the generators but not their current flags: run
 * bare, create-next-app asks seven questions (and "npx tailwindcss init -p" fails on Tailwind 4),
 * so the model wrote setup steps for the user instead of a project. Known frameworks and
 * languages run their official generator with every question answered by flags (checked against
 * each generator's --help and a real run); anything else gets a folder with git, and the model
 * writes the files. Either way the agent then works inside the new folder.
 */

export interface Options {
  typescript: boolean;
  tailwind: boolean;
}

interface Generator {
  label: string;
  /** Other names for it ("next.js", "golang"). */
  aliases?: string[];
  /** Run in the working folder, in order. */
  commands(name: string, o: Options): string[];
  /** A finished project has one of these. */
  manifest: string[];
  /** Files the generator wrote that the model will rewrite whole (replaced without reading first). */
  starter?(o: Options): string[];
  /** Where things go and how to check the work. */
  notes(o: Options): string;
  /** Setup the generator can't do itself (Tailwind in Vite). */
  after?(dir: string, o: Options): void;
  /** Sets up Tailwind CSS when asked. */
  tailwind?: boolean;
  /** The command it needs installed. */
  needs?: string;
  /** Folder names must be snake_case (Dart and Flutter package names). */
  snake?: boolean;
  /** Its name in a detected project's stack ("Next.js"), when detection knows it. */
  stack?: string;
}

/** How every new project is built: the user's standing instruction. */
export const PRINCIPLES =
  "Build it SOLID and YAGNI: only what was asked, nothing for later (no extra features, layers, options or packages); one job per file, component or module; parts meet through small, clear interfaces; add behavior by adding code, not by rewriting what works; no abstraction without a second use.";

const npx = (pkg: string) => `npx -y ${pkg}@latest`;
const TAILWIND_4 =
  'Tailwind CSS 4: there is no tailwind.config.js and no "@tailwind base"; don\'t run "tailwindcss init". The CSS file starts with @import "tailwindcss"; custom colors go in an @theme block there (--color-brand: #e11d2a; gives bg-brand, text-brand).';
const PYPROJECT = ["pyproject.toml", "requirements.txt"];

function vite(template: string, label: string, entry: (o: Options) => string, css: string, aliases: string[]): Generator {
  return {
    label: `${label} (Vite)`,
    aliases,
    stack: ["React", "Vue"].includes(label) ? label : undefined,
    commands: (name, o) => [
      `${npx("create-vite")} ${name} --template ${template}${o.typescript ? "-ts" : ""} --no-interactive --no-immediate`,
      `cd ${name} && npm install${o.tailwind ? " && npm install tailwindcss @tailwindcss/vite" : ""}`,
    ],
    manifest: ["package.json"],
    starter: (o) => [entry(o), css],
    notes: (o) => `${entry(o)} is the main ${template === "vanilla" ? "script" : "component"}, ${css} the global styles. ${o.tailwind ? `${TAILWIND_4} ` : ""}Check your work with \`npm run build\`.`,
    tailwind: true,
    after(dir, o) {
      if (!o.tailwind) return;
      const config = ["vite.config.ts", "vite.config.js"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
      const text = config ? fs.readFileSync(config, "utf8") : "";
      if (config && !text.includes("@tailwindcss/vite")) {
        fs.writeFileSync(config, `import tailwindcss from '@tailwindcss/vite'\n${/plugins:\s*\[/.test(text) ? text.replace(/plugins:\s*\[/, "plugins: [tailwindcss(), ") : text.replace(/defineConfig\(\{/, "defineConfig({\n  plugins: [tailwindcss()],")}`);
      } else if (!config) {
        fs.writeFileSync(path.join(dir, "vite.config.js"), "import { defineConfig } from 'vite'\nimport tailwindcss from '@tailwindcss/vite'\n\nexport default defineConfig({\n  plugins: [tailwindcss()],\n})\n");
      }
      const style = path.join(dir, css);
      const old = fs.existsSync(style) ? fs.readFileSync(style, "utf8") : "";
      if (!old.includes('@import "tailwindcss"')) fs.writeFileSync(style, `@import "tailwindcss";\n\n${old}`);
    },
  };
}

function python(label: string, aliases: string[], packages: string[], notes: string): Generator {
  return {
    label,
    aliases,
    stack: "Python",
    commands: (name) => [`uv init ${name}${packages.length ? ` && cd ${name} && uv add ${packages.map((p) => `'${p}'`).join(" ")}` : ""}`],
    manifest: PYPROJECT,
    notes: () => `${notes} Run things with \`uv run …\`, add packages with \`uv add <pkg>\`; for tests \`uv add --dev pytest\`, then \`uv run pytest\`.`,
    needs: "uv",
  };
}

export const GENERATORS: Record<string, Generator> = {
  // --- web ------------------------------------------------------------------------------
  nextjs: {
    label: "Next.js",
    stack: "Next.js",
    aliases: ["next", "next.js", "next js", "nextjs-app"],
    commands: (name, o) => [
      `${npx("create-next-app")} ${name} ${o.typescript ? "--ts" : "--js"} ${o.tailwind ? "--tailwind" : "--no-tailwind"} --eslint --app --src-dir --import-alias "@/*" --use-npm --yes --no-agent-feedback`,
    ],
    manifest: ["package.json"],
    starter: (o) => [`src/app/page.${o.typescript ? "tsx" : "js"}`, `src/app/layout.${o.typescript ? "tsx" : "js"}`, "src/app/globals.css"],
    notes: (o) => {
      const x = o.typescript ? "tsx" : "js";
      return `App Router in src/app: src/app/page.${x} is the home page (replace it whole with write_file), src/app/layout.${x} the root layout (metadata, fonts), src/app/globals.css the global styles; put sections in src/components/ and images in public/. ${o.tailwind ? `${TAILWIND_4} ` : ""}Check your work with \`npm run build\` and \`npm run lint\`.`;
    },
    tailwind: true,
  },
  "vite-react": vite("react", "React", (o) => `src/App.${o.typescript ? "tsx" : "jsx"}`, "src/index.css", ["react", "reactjs", "react.js", "vite"]),
  "vite-vue": vite("vue", "Vue", () => "src/App.vue", "src/style.css", ["vue", "vuejs", "vue.js"]),
  "vite-preact": vite("preact", "Preact", (o) => `src/app.${o.typescript ? "tsx" : "jsx"}`, "src/index.css", ["preact"]),
  "vite-solid": vite("solid", "Solid", (o) => `src/App.${o.typescript ? "tsx" : "jsx"}`, "src/index.css", ["solid", "solidjs", "solid.js"]),
  "vite-vanilla": vite("vanilla", "HTML, CSS and JavaScript", (o) => `src/main.${o.typescript ? "ts" : "js"}`, "src/style.css", ["vanilla", "vanilla-js"]),
  astro: {
    label: "Astro",
    commands: (name, o) => [`${npx("create-astro")} ${name} --template minimal --install --git --yes --skip-houston${o.tailwind ? " --add tailwind" : ""}`],
    manifest: ["package.json"],
    starter: () => ["src/pages/index.astro"],
    notes: (o) =>
      `src/pages/index.astro is the home page; components go in src/components/, layouts in src/layouts/. ${o.tailwind ? `${TAILWIND_4} The CSS file is src/styles/global.css; import it in the page or layout. ` : ""}Check your work with \`npm run build\`.`,
    tailwind: true,
  },
  sveltekit: {
    label: "SvelteKit",
    stack: "Svelte",
    aliases: ["svelte", "svelte-kit"],
    // Every add-on option is given: "--add tailwindcss" alone asks about plugins (and exits 0 having made nothing).
    commands: (name, o) => [`${npx("sv")} create ${name} --template minimal --types ${o.typescript ? "ts" : "jsdoc"} ${o.tailwind ? '--add tailwindcss="plugins:none"' : "--no-add-ons"} --install npm`],
    manifest: ["package.json"],
    starter: () => ["src/routes/+page.svelte"],
    notes: (o) => `src/routes/+page.svelte is the home page, src/routes/+layout.svelte the layout; components go in src/lib/. ${o.tailwind ? `${TAILWIND_4} The CSS file is src/routes/layout.css. ` : ""}Check your work with \`npm run check\` and \`npm run build\`.`,
    tailwind: true,
  },
  nuxt: {
    label: "Nuxt",
    aliases: ["nuxtjs", "nuxt.js"],
    commands: (name) => [`${npx("create-nuxt")} ${name} --template minimal --packageManager npm --gitInit`],
    manifest: ["package.json"],
    starter: () => ["app/app.vue"],
    notes: () => "app/app.vue is the root component; pages go in app/pages/, components in app/components/. Check your work with `npm run build`.",
  },
  angular: {
    label: "Angular",
    stack: "Angular",
    aliases: ["ng", "angularjs"],
    commands: (name) => [`NG_CLI_ANALYTICS=false ${npx("@angular/cli")} new ${name} --defaults --ssr=false --style=css --package-manager=npm --ai-config=none`],
    manifest: ["angular.json"],
    notes: () => "src/app/ holds the root component (app.ts, app.html, app.css); add components with `npx ng generate component <name>`. Check your work with `npm run build` and `npm test -- --watch=false`.",
  },
  // --- servers and scripts ---------------------------------------------------------------
  node: {
    label: "Node.js with TypeScript",
    aliases: ["nodejs", "node.js", "typescript", "ts", "javascript", "js"],
    commands: (name) => [`mkdir ${name} && cd ${name} && npm init -y && npm install -D typescript @types/node tsx && npx tsc --init && git init -q`],
    manifest: ["package.json"],
    notes: () => 'Write the code in src/ (src/index.ts first); run it with `npx tsx src/index.ts`. Add "build": "tsc" and "start" scripts to package.json as needed. Check your work with `npx tsc --noEmit`.',
  },
  express: {
    label: "Express (Node.js, TypeScript)",
    stack: "Express",
    aliases: ["express.js", "expressjs", "node-api", "rest-api"],
    commands: (name) => [`mkdir ${name} && cd ${name} && npm init -y && npm install express && npm install -D typescript @types/node @types/express tsx && npx tsc --init && git init -q`],
    manifest: ["package.json"],
    notes: () => "Write the server in src/ (src/index.ts creates the app and listens; routes in src/routes/); run it with `npx tsx src/index.ts`. Check your work with `npx tsc --noEmit`.",
  },
  nestjs: {
    label: "NestJS",
    stack: "NestJS",
    aliases: ["nest"],
    commands: (name) => [`${npx("@nestjs/cli")} new ${name} --package-manager npm --strict`],
    manifest: ["package.json"],
    notes: () => "src/main.ts boots the app, src/app.module.ts wires modules; add features with `npx nest generate resource <name>`. Check your work with `npm run build` and `npm test`.",
  },
  bun: {
    label: "Bun",
    commands: (name) => [`mkdir ${name} && cd ${name} && bun init -y && git init -q`],
    manifest: ["package.json"],
    notes: () => "index.ts is the entry point; run it with `bun run index.ts`. Check your work with `bun test`.",
    needs: "bun",
  },
  deno: {
    label: "Deno",
    commands: (name) => [`deno init ${name} && cd ${name} && git init -q`],
    manifest: ["deno.json", "deno.jsonc"],
    notes: () => "main.ts is the entry point, main_test.ts its tests. Check your work with `deno check main.ts` and `deno test`.",
    needs: "deno",
  },
  python: python("Python", ["py", "python3", "python-app", "python-cli"], [], "main.py is the entry point; put modules next to it, or in a package as it grows."),
  "python-lib": {
    ...python("Python library", ["python-library", "pypi"], [], "The package is in src/<name>/."),
    commands: (name) => [`uv init --lib ${name}`],
  },
  fastapi: python("FastAPI", ["fast-api"], ["fastapi[standard]"], "Write the app in main.py (app = FastAPI()), routers in their own modules; run it with `uv run fastapi dev main.py`."),
  flask: python("Flask", [], ["flask"], "Write the app in app.py (app = Flask(__name__)); run it with `uv run flask --app app run`."),
  django: {
    ...python("Django", [], [], ""),
    commands: (name) => [`mkdir ${name} && cd ${name} && uv init --bare && uv add django && uv run django-admin startproject config . && git init -q`],
    manifest: ["manage.py"],
    notes: () =>
      "config/ holds settings and urls; add an app with `uv run python manage.py startapp <name>` and list it in config/settings.py. Check your work with `uv run python manage.py check` and `uv run python manage.py test`.",
  },
  go: {
    label: "Go",
    stack: "Go",
    aliases: ["golang"],
    commands: (name) => [`mkdir ${name} && cd ${name} && go mod init example.com/${name} && git init -q`],
    manifest: ["go.mod"],
    notes: () => "Write main.go (package main) first; packages go in their own folders (internal/<name>/). Check your work with `go vet ./...`, `go build ./...` and `go test ./...`.",
    needs: "go",
  },
  rust: {
    label: "Rust",
    stack: "Rust",
    aliases: ["cargo", "rust-cli"],
    commands: (name) => [`cargo new ${name}`],
    manifest: ["Cargo.toml"],
    starter: () => ["src/main.rs"],
    notes: () => "src/main.rs is the entry point; modules go in src/<name>.rs. Check your work with `cargo build`, `cargo clippy` and `cargo test`.",
    needs: "cargo",
  },
  "rust-lib": {
    label: "Rust library",
    stack: "Rust",
    aliases: ["rust-library", "crate"],
    commands: (name) => [`cargo new --lib ${name}`],
    manifest: ["Cargo.toml"],
    starter: () => ["src/lib.rs"],
    notes: () => "src/lib.rs is the library root. Check your work with `cargo build` and `cargo test`.",
    needs: "cargo",
  },
  swift: {
    label: "Swift package",
    aliases: ["swift-package", "swiftpm"],
    commands: (name) => [`mkdir ${name} && cd ${name} && swift package init --type executable && git init -q`],
    manifest: ["Package.swift"],
    notes: () => "Sources/<name>/<name>.swift is the entry point (@main). Check your work with `swift build` and `swift test`.",
    needs: "swift",
  },
  dart: {
    label: "Dart",
    stack: "Dart",
    commands: (name) => [`dart create -t console ${name}`],
    manifest: ["pubspec.yaml"],
    notes: () => "bin/ has the entry point, lib/ the code, test/ the tests. Check your work with `dart analyze` and `dart test`.",
    needs: "dart",
    snake: true,
  },
  flutter: {
    label: "Flutter",
    stack: "Flutter",
    commands: (name) => [`flutter create --org com.example ${name}`],
    manifest: ["pubspec.yaml"],
    starter: () => ["lib/main.dart", "test/widget_test.dart"],
    notes: () => "lib/main.dart is the app's entry point; put screens in lib/screens/ and widgets in lib/widgets/. Check your work with `flutter analyze` and `flutter test`.",
    needs: "flutter",
    snake: true,
  },
  expo: {
    label: "Expo (React Native)",
    aliases: ["react-native", "react native"],
    commands: (name) => [`${npx("create-expo-app")} ${name} --yes`],
    manifest: ["package.json"],
    notes: () => "Screens are files in src/app/ (Expo Router): src/app/index.tsx is the first screen, src/app/_layout.tsx the navigation; components go in src/components/, colors in src/constants/theme.ts. Check your work with `npx tsc --noEmit` and `npx expo lint`.",
  },
  "spring-boot": {
    label: "Spring Boot (Java, Maven)",
    aliases: ["spring", "springboot", "java-spring"],
    // Spring Initializr, the official generator, over its HTTP API.
    commands: (name) => [
      `curl -fsSL https://start.spring.io/starter.zip -d type=maven-project -d language=java -d dependencies=web -d baseDir=${name} -d artifactId=${name} -d name=${name} -o ${name}.zip && unzip -q ${name}.zip && rm ${name}.zip && cd ${name} && git init -q`,
    ],
    manifest: ["pom.xml"],
    notes: () => "src/main/java/com/example/… has the application class; add controllers and services beside it. Check your work with `./mvnw -q test`.",
    needs: "java",
  },
  dotnet: {
    label: ".NET (C#)",
    aliases: ["csharp", "c#", ".net", "dotnet-console"],
    commands: (name) => [`dotnet new console -o ${name} && cd ${name} && git init -q`],
    manifest: [".csproj"],
    notes: () => "Program.cs is the entry point. Check your work with `dotnet build` and `dotnet test`.",
    needs: "dotnet",
  },
  aspnet: {
    label: "ASP.NET Core Web API",
    aliases: ["asp.net", "asp.net core", "webapi", "dotnet-webapi"],
    commands: (name) => [`dotnet new webapi -o ${name} && cd ${name} && git init -q`],
    manifest: [".csproj"],
    notes: () => "Program.cs sets up the app and its endpoints. Check your work with `dotnet build`.",
    needs: "dotnet",
  },
  rails: {
    label: "Ruby on Rails",
    aliases: ["ruby-on-rails", "ror"],
    commands: (name) => [`rails new ${name}`],
    manifest: ["Gemfile"],
    notes: () => "Generate pieces with `bin/rails generate …`. Check your work with `bin/rails test`.",
    needs: "rails",
  },
  "ruby-gem": {
    label: "Ruby gem",
    aliases: ["ruby", "gem"],
    commands: (name) => [`bundle gem ${name} --test=minitest --no-ci --no-linter --no-mit --no-coc --no-changelog`],
    manifest: ["Gemfile"],
    notes: () => "lib/ has the code, test/ the tests. Check your work with `bundle exec rake test`.",
    needs: "bundle",
    snake: true,
  },
  laravel: {
    label: "Laravel",
    stack: "Laravel",
    commands: (name) => [`composer create-project laravel/laravel ${name} --no-interaction --prefer-dist`],
    manifest: ["artisan"],
    starter: () => ["resources/views/welcome.blade.php"],
    notes: () => "Routes in routes/web.php, views in resources/views/ (welcome.blade.php is the home page), controllers in app/Http/Controllers/. Check your work with `php artisan test`.",
    needs: "composer",
  },
  symfony: {
    label: "Symfony",
    stack: "PHP",
    commands: (name) => [`composer create-project symfony/skeleton ${name} --no-interaction`],
    manifest: ["composer.json"],
    notes: () => "Controllers in src/Controller/, config in config/. Check your work with `php bin/console lint:container`.",
    needs: "composer",
  },
  elixir: {
    label: "Elixir (Mix)",
    aliases: ["mix"],
    commands: (name) => [`mix new ${name}`],
    manifest: ["mix.exs"],
    notes: () => "lib/ has the code, test/ the tests. Check your work with `mix compile` and `mix test`.",
    needs: "mix",
    snake: true,
  },
};

// Names the model or the user may use for each generator.
const ALIASES = new Map<string, string>();
for (const [key, g] of Object.entries(GENERATORS)) for (const name of [key, ...(g.aliases ?? [])]) ALIASES.set(name.toLowerCase(), key);

/** The generator for a framework or language name ("Next.js", "golang"), or null: an empty project. */
export function generatorFor(framework: string): string | null {
  const f = framework.trim().toLowerCase();
  return ALIASES.get(f) ?? ALIASES.get(f.replace(/\s+/g, "-")) ?? ALIASES.get(f.replace(/[\s.]+/g, "")) ?? null;
}

// Request words for each generator, most specific first ("next.js" before "react").
const NAMED: [RegExp, string][] = [
  [/\bnext(?:\.?js| js)\b/, "nextjs"],
  [/\bnuxt(?:\.?js)?\b/, "nuxt"],
  [/\b(?:expo|react[ -]native)\b/, "expo"],
  [/\bsvelte(?:kit)?\b/, "sveltekit"],
  [/\bastro\b/, "astro"],
  [/\bangular\b/, "angular"],
  [/\bnest(?:js)?\b/, "nestjs"],
  [/\bexpress(?:\.?js)?\b/, "express"],
  [/\bpreact\b/, "vite-preact"],
  [/\bsolid(?:\.?js)?\b/, "vite-solid"],
  [/\breact(?:\.?js)?\b/, "vite-react"],
  [/\bvue(?:\.?js)?\b/, "vite-vue"],
  [/\bfastapi\b/, "fastapi"],
  [/\bdjango\b/, "django"],
  [/\bflask\b/, "flask"],
  [/\bpython\b/, "python"],
  [/\bflutter\b/, "flutter"],
  [/\bdart\b/, "dart"],
  [/\blaravel\b/, "laravel"],
  [/\bsymfony\b/, "symfony"],
  [/\bspring(?: ?boot)?\b/, "spring-boot"],
  [/\b(?:asp\.net|aspnet)\b/, "aspnet"],
  [/\b(?:c#|csharp|\.net|dotnet)(?![\w])/, "dotnet"],
  [/\b(?:rails|ruby on rails)\b/, "rails"],
  [/\bruby\b/, "ruby-gem"],
  [/\b(?:golang|go (?:app|api|service|server|cli|project|module))\b/, "go"],
  [/\brust\b/, "rust"],
  [/\bswift\b/, "swift"],
  [/\belixir\b/, "elixir"],
  [/\bdeno\b/, "deno"],
  [/\bbun\b/, "bun"],
  [/\bnode(?:\.?js)?\b|\btypescript\b/, "node"],
];

/** The generator a request names ("using nextjs and tailwindcss", "a FastAPI service"), if any. */
export function frameworkIn(request: string): string | null {
  const r = request.toLowerCase();
  return NAMED.find(([re]) => re.test(r))?.[1] ?? null;
}

/** The label of a generator ("Next.js"). */
export function generatorLabel(key: string): string {
  return GENERATORS[key]?.label ?? key;
}

/** What a project made by this generator is called in a detected stack ("Next.js"), if known. */
export function generatorStack(key: string): string | undefined {
  return GENERATORS[key]?.stack;
}

// The project's folder: one name in the working folder, lowercase (npm refuses capitals).
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function folderName(raw: string, snake = false): string {
  let name = raw.trim().toLowerCase().replace(/\s+/g, "-");
  if (snake) name = name.replace(/[-.]/g, "_");
  if (!NAME.test(name) || name.includes("..")) throw new Error(`"${raw}" can't be a project folder: use a short name like my-app (letters, digits, - _ .)`);
  return name;
}

function options(args: Args): Options {
  return { typescript: args.typescript !== false, tailwind: args.tailwind !== false };
}

/** The commands create_project runs for these arguments (none: an empty project with git). */
export function generatorCommands(args: Args): string[] {
  const key = generatorFor(reqStr(args, "framework"));
  const g = key ? GENERATORS[key] : null;
  const name = folderName(reqStr(args, "name"), g?.snake);
  return g ? g.commands(name, options(args)) : [`mkdir ${name} && cd ${name} && git init -q`];
}

// Flags of the generators that take a value ("--template react-ts"): the value isn't the name.
const WITH_VALUE = new Set(["--template", "-t", "--org", "--project-name", "--platforms", "--import-alias", "--types", "--add", "--packageManager", "--package-manager", "-e", "--example", "--description", "--name"]);
const COMMANDS: [RegExp, string][] = [
  [/\bcreate-next-app\b/, "nextjs"],
  [/\b(?:create-vite\b|(?:npm|pnpm|yarn|bun) create vite\b)/, "vite"],
  [/\b(?:create-astro\b|(?:npm|pnpm|yarn|bun) create astro\b)/, "astro"],
  [/\b(?:sv(?:@\S+)? create\b|create-svelte\b)/, "sveltekit"],
  [/\b(?:create-nuxt(?:-app)?\b|nuxi(?:@\S+)? init\b|(?:npm|pnpm|yarn|bun) create nuxt\b)/, "nuxt"],
  [/\bcreate-expo(?:-app)?\b/, "expo"],
  [/(?:@angular\/cli\S*|\bng) new\b/, "angular"],
  [/(?:@nestjs\/cli\S*|\bnest) new\b/, "nestjs"],
  [/\bflutter create\b/, "flutter"],
  [/\bdart create\b/, "dart"],
  [/\bcargo new\b/, "rust"],
  [/\bdjango-admin startproject\b/, "django"],
  [/\bdotnet new (?:console|webapi)\b/, "dotnet"],
  [/\brails new\b/, "rails"],
  [/\bmix new\b/, "elixir"],
  [/\b(?:composer create-project(?: --\S+)* laravel\/laravel\b|laravel new\b)/, "laravel"],
];

/**
 * The project a shell command creates with a generator create_project knows
 * ("npx create-next-app@latest cote-web\ncd cote-web\nnpm install tailwindcss"), as create_project
 * arguments; null for anything else.
 */
export function scaffoldArgs(command: string): Args | null {
  for (const line of command.split(/\n|&&|;/)) {
    for (const [re, kind] of COMMANDS) {
      const m = re.exec(line);
      if (!m) continue;
      // After the generator's version ("create-next-app@latest"), the folder and the flags.
      const words = line.slice(m.index + m[0].length).replace(/^@\S*/, "").trim().split(/\s+/).filter(Boolean);
      let name: string | undefined;
      let template = "";
      for (let i = 0; i < words.length; i++) {
        const w = words[i].replace(/^['"]|['"]$/g, "");
        if (w.startsWith("-")) {
          if (/^--?t(?:emplate)?$/.test(w)) template = words[i + 1] ?? "";
          if (WITH_VALUE.has(w)) i++;
          continue;
        }
        if (["console", "webapi"].includes(w)) continue; // dotnet new <template>
        name ??= w;
      }
      if (!name || !/^[\w.-]+$/.test(name) || name === ".") return null;
      let framework = kind;
      if (kind === "vite") {
        const base = template.replace(/-ts$/, "") || "react";
        if (!GENERATORS[`vite-${base}`]) return null;
        framework = `vite-${base}`;
      }
      if (kind === "dotnet" && /\bwebapi\b/.test(line)) framework = "aspnet";
      if (kind === "rust" && /--lib\b/.test(line)) framework = "rust-lib";
      const args: Args = { framework, name };
      if (/--js\b|--javascript\b/.test(line) || (kind === "vite" && template && !template.endsWith("-ts"))) args.typescript = false;
      if (/tailwind/i.test(command)) args.tailwind = true;
      return args;
    }
  }
  return null;
}

/** Whether a command is on the PATH. */
function installed(command: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

/** Files of a project folder, a few levels deep, for the result: what the model works with. */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= 40) return;
      if (e.name.startsWith(".") || ["node_modules", "build", "dist", "target", "ios", "android", "macos", "windows", "linux", "web", "vendor", "storage", "__pycache__"].includes(e.name)) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (!e.isDirectory()) out.push(p);
      else if (depth < 2) walk(p, depth + 1);
      else out.push(`${p}/`);
    }
  };
  walk("", 0);
  return out;
}

const MANIFESTS = [...new Set(Object.values(GENERATORS).flatMap((g) => g.manifest))];

function hasManifest(dir: string, names: string[]): boolean {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  // ".csproj" stands for any <name>.csproj.
  return names.some((m) => (m.startsWith(".") ? entries.some((e) => e.endsWith(m)) : entries.includes(m)));
}

function tail(output: string, lines = 25): string {
  return output.trim().split("\n").slice(-lines).join("\n");
}

export const createProject: Tool = {
  name: "create_project",
  label: "Create",
  description:
    "Create a new project of any kind in a new folder: known frameworks and languages (nextjs, vite-react, vite-vue, astro, sveltekit, nuxt, angular, express, nestjs, node, python, fastapi, django, flask, go, rust, swift, dart, flutter, expo, spring-boot, dotnet, aspnet, rails, laravel, symfony, elixir, …) run their official generator without questions and install dependencies (TypeScript and Tailwind CSS by default on the web); anything else gets an empty folder with git, for you to write the files. Afterwards the working folder is the new project. Use it whenever the user asks for a new project or app, instead of writing setup steps for the user.",
  parameters: {
    type: "object",
    properties: {
      framework: { type: "string", description: "Framework or language, e.g. nextjs, django, go, rust, spring-boot" },
      name: { type: "string", description: "Folder name, e.g. my-app" },
      typescript: { type: "boolean", description: "Default true" },
      tailwind: { type: "boolean", description: "Tailwind CSS (web frameworks). Default true" },
    },
    required: ["framework", "name"],
  },
  lean: {
    description: "Create a new project of any kind (framework or language: nextjs, vite-react, django, fastapi, go, rust, flutter, laravel, …) and move into it. Use it instead of setup steps.",
    parameters: {
      type: "object",
      properties: { framework: { type: "string" }, name: { type: "string" }, tailwind: { type: "boolean" } },
      required: ["framework", "name"],
    },
  },
  risk: "exec",
  needs: () => "approval",
  timeoutMs: 0, // the generator runs through bash, with its own time limit
  describe: (a) => `create a ${generatorLabel(generatorFor(String(a.framework)) ?? String(a.framework))} project in ${String(a.name)}/`,
  target: (a) => `${String(a.framework)} ${String(a.name)}`,
  activity: (a) => `Creating ${String(a.name)}`,
  summarize: (_a, output) => ({ summary: output.split("\n")[0].replace(/:.*/, "") }),
  async run(args, ctx: ToolContext) {
    const asked = reqStr(args, "framework");
    const key = generatorFor(asked);
    const g = key ? GENERATORS[key] : null;
    const name = folderName(reqStr(args, "name"), g?.snake);
    const o = options(args);
    const dir = path.join(ctx.cwd, name);
    // Asked twice (or the folder was made by hand): work in it rather than fail.
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
      if (!hasManifest(dir, MANIFESTS)) throw new Error(`${name}/ already exists and isn't empty; pick another name`);
      ctx.enterProject?.(dir, []);
      return `${name}/ already exists, so nothing was created. The working folder is now ${name}/.\nFiles: ${listing(dir).join(", ")}\n${PRINCIPLES}`;
    }
    if (g?.needs && !installed(g.needs)) throw new Error(`${g.label} needs ${g.needs}, which isn't installed here. Ask the user to install it, or pick another stack.`);
    for (const command of generatorCommands({ ...args, framework: asked })) {
      const output = await bash.run({ command, timeout_seconds: 900 }, ctx);
      if (!output.startsWith("exit code 0")) throw new Error(`${command} failed:\n${tail(output)}`);
    }
    // Some generators end with exit 0 having made nothing (a question they couldn't ask).
    if (!fs.existsSync(dir) || (g && !hasManifest(dir, g.manifest))) throw new Error(`the generator finished but ${name}/ has no ${g?.manifest.join(" or ") ?? "folder"}: it didn't create the project`);
    // Some generators report a failed install and still exit 0 (seen with Nest's npm install).
    let install = "";
    if (fs.existsSync(path.join(dir, "package.json")) && !fs.existsSync(path.join(dir, "node_modules")) && g?.commands(name, o).some((c) => /npx|npm/.test(c))) {
      const output = await bash.run({ command: "npm install", timeout_seconds: 900 }, { ...ctx, cwd: dir });
      if (!output.startsWith("exit code 0")) install = `npm install failed, so dependencies are missing; fix that first:\n${tail(output, 10)}`;
    }
    g?.after?.(dir, o);
    // The generator's starter files: the model replaces them whole, without reading them first.
    const starter = (g?.starter?.(o) ?? []).map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
    for (const f of starter) ctx.files?.set(f, hashText(fs.readFileSync(f, "utf8")));
    ctx.enterProject?.(dir, starter);
    const extras = g ? [o.typescript && g.tailwind && "TypeScript", g.tailwind && o.tailwind && "Tailwind CSS"].filter(Boolean).join(", ") : "";
    const files = listing(dir);
    return [
      g
        ? `Created ${name}/: a ${g.label} project${extras ? ` with ${extras}` : ""}, made by its official generator. The working folder is now ${name}/: paths and commands are relative to it.`
        : `Created ${name}/ with git (no generator is known for "${asked}"). The working folder is now ${name}/: write the project's files yourself: its manifest or build file first, then the code, a README saying how to build and run it, and a .gitignore.`,
      install,
      g ? g.notes(o) : "",
      starter.length ? `Replace these starter files whole with write_file (no need to read them first): ${starter.map((f) => path.relative(dir, f)).join(", ")}.` : "",
      files.length ? `Files: ${files.join(", ")}` : "",
      PRINCIPLES,
    ]
      .filter(Boolean)
      .join("\n");
  },
};
