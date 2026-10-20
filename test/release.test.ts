import { describe, expect, test } from "bun:test";
import { nextVersion, releaseMessage } from "../scripts/release.js";

describe("bun run release", () => {
  test("patch, minor and major bump the version; an explicit one must be newer", () => {
    expect(nextVersion("0.3.9", "patch")).toBe("0.3.10");
    expect(nextVersion("0.3.9", "minor")).toBe("0.4.0");
    expect(nextVersion("0.3.9", "major")).toBe("1.0.0");
    expect(nextVersion("0.3.9", "0.4.0")).toBe("0.4.0");
    expect(nextVersion("0.3.9", "v0.3.11")).toBe("0.3.11");
    expect(() => nextVersion("0.3.9", "0.3.9")).toThrow("newer than 0.3.9");
    expect(() => nextVersion("0.3.9", "0.3.2")).toThrow("newer than 0.3.9");
    expect(() => nextVersion("0.3.9", "next")).toThrow("patch, minor, major or a version");
  });

  test("pre-releases (a GitHub pre-release, npm's next tag) and the release that follows them", () => {
    expect(nextVersion("0.3.9", "0.4.0-rc.1")).toBe("0.4.0-rc.1");
    expect(nextVersion("0.4.0-rc.1", "0.4.0-rc.2")).toBe("0.4.0-rc.2");
    expect(nextVersion("0.4.0-rc.1", "0.4.0")).toBe("0.4.0");
    expect(() => nextVersion("0.4.0", "0.4.0-rc.3")).toThrow("newer than 0.4.0");
  });

  test("the commit and tag message follows the earlier releases", () => {
    expect(releaseMessage("0.3.10", "  faster answers ")).toBe("release: 0.3.10 — faster answers");
    expect(releaseMessage("0.3.10", "")).toBe("release: 0.3.10");
  });
});
