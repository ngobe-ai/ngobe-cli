import fs from "node:fs";
import path from "node:path";

/**
 * Mistakes from a small model's stale training data, fixed as a file is written, with a note so the
 * model learns what changed. Only rewrites that are always right for the project's versions: seen
 * live in every run, the 7B wrote Tailwind 3's directives into a Tailwind 4 project, and the build
 * failed ("@tailwind base" is gone, "tailwindcss/base" doesn't resolve).
 */

const TAILWIND_3 = /^[ \t]*(?:@tailwind\s+(?:base|components|utilities)\s*;|@import\s+["']tailwindcss\/(?:base|components|utilities)(?:\.css)?["']\s*;)[ \t]*\r?\n?/gm;

/** The content to write, and what was changed in it (null: nothing). */
export function fixStale(file: string, content: string, cwd: string): { content: string; note: string | null } {
  if (!file.endsWith(".css") || !content.match(TAILWIND_3) || tailwindMajor(path.dirname(file), cwd) !== 4) return { content, note: null };
  const rest = content.replace(TAILWIND_3, "").replace(/^\s*\n/, "").replace(/\n{3,}/g, "\n\n");
  const fixed = /@import\s+["']tailwindcss["']/.test(rest) ? rest : `@import "tailwindcss";\n${rest}`;
  return { content: fixed, note: 'This project has Tailwind 4: the Tailwind 3 directives were changed to @import "tailwindcss"; (custom colors go in @theme { --color-brand: #e11d2a; }).' };
}

/** The Tailwind major version of the nearest package.json from `dir` up to the project root, if any. */
function tailwindMajor(dir: string, root: string): number | null {
  for (let d = dir; ; d = path.dirname(d)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["@tailwindcss/postcss"] || deps["@tailwindcss/vite"]) return 4;
      const v = /(\d+)/.exec(deps.tailwindcss ?? "")?.[1];
      return v ? Number(v) : null;
    } catch {
      // no package.json here
    }
    if (path.relative(root, d) === "" || d === path.dirname(d)) return null;
  }
}
