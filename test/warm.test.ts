import { describe, expect, test } from "bun:test";
import { shouldKeepWarm } from "../src/warm.js";

const MIN = 60_000;

describe("keep-warm", () => {
  test("pings before the server's 5-minute unload while the user is around", () => {
    expect(shouldKeepWarm({ idleMs: 4 * MIN, sinceUserMs: 10 * MIN, busy: false, keepWarmMinutes: 30 })).toBe(true);
    expect(shouldKeepWarm({ idleMs: 1 * MIN, sinceUserMs: 10 * MIN, busy: false, keepWarmMinutes: 30 })).toBe(false); // recently used
  });

  test("stops once the user has been away, during a run, or when turned off", () => {
    expect(shouldKeepWarm({ idleMs: 4 * MIN, sinceUserMs: 31 * MIN, busy: false, keepWarmMinutes: 30 })).toBe(false);
    expect(shouldKeepWarm({ idleMs: 4 * MIN, sinceUserMs: 1 * MIN, busy: true, keepWarmMinutes: 30 })).toBe(false);
    expect(shouldKeepWarm({ idleMs: 4 * MIN, sinceUserMs: 1 * MIN, busy: false, keepWarmMinutes: 0 })).toBe(false);
  });
});
