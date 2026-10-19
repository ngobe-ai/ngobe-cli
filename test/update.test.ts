import { describe, expect, test } from "bun:test";
import { assetName, installMethod } from "../src/update.js";

describe("release asset for a machine", () => {
  test.each([
    ["linux", "x64", true, "ngobe-linux-x64.tar.gz"],
    ["linux", "x64", false, "ngobe-linux-x64-baseline.tar.gz"], // no AVX2
    ["linux", "arm64", true, "ngobe-linux-arm64.tar.gz"],
    ["darwin", "arm64", true, "ngobe-darwin-arm64.tar.gz"],
    ["darwin", "x64", false, "ngobe-darwin-x64.tar.gz"], // baseline only matters on Linux
  ])("%s %s (avx2 %p) → %s", (platform, arch, avx2, expected) => {
    expect(assetName(platform, arch, avx2)).toBe(expected);
  });

  test("other platforms are pointed at npm", () => {
    expect(() => assetName("win32", "x64", true)).toThrow("install with npm");
    expect(() => assetName("linux", "ia32", true)).toThrow("install with npm");
  });
});

describe("install method", () => {
  test("standalone binaries: Homebrew Cellar or a plain download", () => {
    expect(installMethod({ standalone: true, execPath: "/opt/homebrew/Cellar/ngobe/0.2.0/bin/ngobe" })).toBe("homebrew");
    expect(installMethod({ standalone: true, execPath: "/home/linuxbrew/.linuxbrew/Cellar/ngobe/0.2.0/bin/ngobe" })).toBe("homebrew");
    expect(installMethod({ standalone: true, execPath: "/home/me/.local/bin/ngobe" })).toBe("binary");
  });

  test("the npm package, or a source checkout", () => {
    expect(installMethod({ standalone: false, script: "/usr/lib/node_modules/@ngobe-ai/ngobe/dist/index.js" })).toBe("npm");
    expect(installMethod({ standalone: false, script: "/opt/ngobe-cli/dist/index.js" })).toBe("source");
  });
});
