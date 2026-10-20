import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { diffPreview, highlight } from "../src/diff.js";
import { editFile } from "../src/tools/editFile.js";
import { writeFile } from "../src/tools/writeFile.js";
import type { PreviewLine, ToolContext } from "../src/types.js";
import { tmpDir } from "./helpers.js";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const show = (p: PreviewLine[]) => p.map((l) => `${l.line ?? ""}${l.tone === "add" ? "+" : l.tone === "remove" ? "-" : " "}${l.text}`);

describe("diffs like Claude Code's", () => {
  test("a change shows with 3 lines of context, removed lines numbered as before, the rest as after", () => {
    const before = lines(10);
    const after = before.replace("line 5\n", "line five\nline 5b\n");
    const d = diffPreview(before, after);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(show(d.lines)).toEqual(["2 line 2", "3 line 3", "4 line 4", "5-line 5", "5+line five", "6+line 5b", "7 line 6", "8 line 7", "9 line 8"]);
  });

  test("changes far apart are separate hunks", () => {
    const before = lines(40);
    const after = before.replace("line 3\n", "line three\n").replace("line 35\n", "line thirty-five\n");
    const d = diffPreview(before, after);
    expect(d.lines.filter((l) => l.tone === "dim").map((l) => l.text)).toEqual(["…"]);
    expect(show(d.lines).filter((l) => /[+-]/.test(l[l.search(/\D/)]))).toEqual(["3-line 3", "3+line three", "35-line 35", "35+line thirty-five"]);
  });

  test("code gets syntax colors", () => {
    const parts = highlight('const x = "hi"; // greet', "ts");
    expect(parts.find((p) => p.text === "const")?.color).toBeDefined();
    expect(parts.find((p) => p.text === '"hi"')?.color).toBeDefined();
    expect(parts.find((p) => p.text.startsWith("//"))?.color).toBeDefined();
    expect(parts.map((p) => p.text).join("")).toBe('const x = "hi"; // greet');
  });
});

describe("edit and write show what changed", () => {
  function ctx(cwd: string) {
    const reported: { summary: string; preview?: PreviewLine[] }[] = [];
    const files = new Map<string, string>();
    const c: ToolContext = { cwd, files, report: (v) => void reported.push(v) };
    return { c, reported, files };
  }

  test("edit_file reports 'Updated <file> (+a −r)' with the numbered diff", async () => {
    const cwd = tmpDir();
    fs.writeFileSync(path.join(cwd, "db.ts"), lines(50));
    const { c, reported } = ctx(cwd);
    const { readFile } = await import("../src/tools/readFile.js");
    await readFile.run({ path: "db.ts" }, c);
    await editFile.run({ path: "db.ts", old_string: "line 45\n", new_string: "// note\nline 45 fixed\n" }, c);
    expect(reported[0].summary).toBe("Updated db.ts (+2 −1)");
    expect(show(reported[0].preview!)).toContain("45-line 45");
    expect(show(reported[0].preview!)).toContain("46+line 45 fixed");
    expect(reported[0].preview!.find((l) => l.tone === "add")?.lang).toBe("ts");
  });

  test("write_file: a new file shows its first lines; an overwrite shows the diff", async () => {
    const cwd = tmpDir();
    const { c, reported } = ctx(cwd);
    await writeFile.run({ path: "new.py", content: "def a():\n    return 1\n" }, c);
    expect(reported[0].summary).toBe("Created new.py (2 lines)");
    expect(show(reported[0].preview!)).toEqual(["1+def a():", "2+    return 1"]);
    await writeFile.run({ path: "new.py", content: "def a():\n    return 2\n" }, c);
    expect(reported[1].summary).toBe("Updated new.py (+1 −1)");
  });
});
