import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ConfigError, isLocalEndpoint, loadConfig, redactedConfig } from "../src/config.js";
import { tmpDir } from "./helpers.js";

const home = () => {
  const dir = tmpDir();
  return { dir, env: { HOME: dir, XDG_CONFIG_HOME: path.join(dir, "cfg") } };
};

describe("config", () => {
  test("NGOBE_* wins over the old MUGAMBA_* names, which still work", () => {
    const { env } = home();
    expect(loadConfig([], { ...env, MUGAMBA_MODEL: "old" }).config.model).toBe("old");
    expect(loadConfig([], { ...env, MUGAMBA_MODEL: "old", NGOBE_MODEL: "new" }).config.model).toBe("new");
  });

  test("flags win over environment", () => {
    const { env } = home();
    expect(loadConfig(["--model", "flag"], { ...env, NGOBE_MODEL: "env" }).config.model).toBe("flag");
  });

  test("strong-model settings: the model sees images, small-model helpers, the reply cap", () => {
    const { env } = home();
    const d = loadConfig([], env).config;
    expect([d.modelSeesImages, d.smallModelHelpers, d.maxReplyTokens]).toEqual([false, true, 4096]);
    const c = loadConfig([], { ...env, NGOBE_MODEL_SEES_IMAGES: "1", NGOBE_SMALL_MODEL_HELPERS: "0", NGOBE_MAX_REPLY_TOKENS: "32000" }).config;
    expect([c.modelSeesImages, c.smallModelHelpers, c.maxReplyTokens]).toEqual([true, false, 32000]);
  });

  test("errors name the variable that was actually set", () => {
    const { env } = home();
    expect(() => loadConfig([], { ...env, MUGAMBA_MAX_TURNS: "abc" })).toThrow("MUGAMBA_MAX_TURNS");
    expect(() => loadConfig([], { ...env, NGOBE_MODE: "yolo" })).toThrow(ConfigError);
  });

  test("reads the user config file but ignores secrets in it", () => {
    const { dir, env } = home();
    fs.mkdirSync(path.join(dir, "cfg", "ngobe"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cfg", "ngobe", "config.json"), JSON.stringify({ model: "from-file", apiKey: "sk-should-not-load", maxTurns: 7 }));
    const loaded = loadConfig([], env);
    expect(loaded.config.model).toBe("from-file");
    expect(loaded.config.maxTurns).toBe(7);
    expect(loaded.config.apiKey).toBe("not-needed");
    expect(loaded.warnings.join()).toContain("apiKey");
  });

  test("--yolo becomes auto mode with a deprecation warning", () => {
    const { env } = home();
    const loaded = loadConfig(["--yolo"], env);
    expect(loaded.config.mode).toBe("auto");
    expect(loaded.warnings.join()).toContain("deprecated");
  });

  test("search providers follow the keys present, or an explicit ordered list", () => {
    const { env } = home();
    expect(loadConfig([], env).config.searchProviders).toEqual([]);
    expect(loadConfig([], { ...env, BRAVE_API_KEY: "k", NGOBE_SEARXNG_URL: "http://s" }).config.searchProviders).toEqual(["brave", "searxng"]);
    expect(loadConfig([], { ...env, NGOBE_SEARCH_PROVIDERS: "searxng,brave" }).config.searchProviders).toEqual(["searxng", "brave"]);
    expect(() => loadConfig([], { ...env, NGOBE_SEARCH_PROVIDERS: "google" })).toThrow("NGOBE_SEARCH_PROVIDERS");
  });

  test("the SearXNG key comes from the environment, never the config file", () => {
    const { dir, env } = home();
    expect(loadConfig([], { ...env, NGOBE_SEARXNG_KEY: "k" }).config.searxngKey).toBe("k");
    fs.mkdirSync(path.join(dir, "cfg", "ngobe"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cfg", "ngobe", "config.json"), JSON.stringify({ searxngURL: "https://s.example", searxngKey: "leaked" }));
    const loaded = loadConfig([], env);
    expect(loaded.config.searxngURL).toBe("https://s.example");
    expect(loaded.config.searxngKey).toBe("");
    expect(loaded.warnings.join()).toContain('"searxngKey" is ignored');
  });

  test("a known command is split from its arguments; anything else is a prompt", () => {
    const { env } = home();
    expect(loadConfig(["version", "flutter"], env)).toMatchObject({ command: "version", args: ["flutter"] });
    expect(loadConfig(["fix the parser"], env)).toMatchObject({ command: null, prompt: "fix the parser" });
  });

  test("secrets are redacted for display", () => {
    const { env } = home();
    const shown = redactedConfig(loadConfig([], { ...env, NGOBE_API_KEY: "sk-abcdefghijklmnop" }).config);
    expect(JSON.stringify(shown)).not.toContain("abcdefghijklmnop");
  });

  test("local endpoints are recognized", () => {
    expect(isLocalEndpoint("http://localhost:12434/engines/v1")).toBe(true);
    expect(isLocalEndpoint("http://model-runner.docker.internal/engines/v1")).toBe(true);
    expect(isLocalEndpoint("http://10.0.0.5:8080/v1")).toBe(true);
    expect(isLocalEndpoint("https://api.example.com/v1")).toBe(false);
  });
});
