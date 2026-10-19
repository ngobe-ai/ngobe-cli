import { afterEach, describe, expect, test } from "bun:test";
import { fetchUrl } from "../src/tools/info.js";
import { htmlToText } from "../src/web/extract.js";
import { http } from "../src/web/http.js";
import { assertPublicUrl, isPublicAddress } from "../src/web/net.js";
import { webSearch } from "../src/web/search.js";
import { isOfficialUrl, techsIn, urlMatches } from "../src/web/sources.js";
import { testConfig, tmpDir } from "./helpers.js";

let servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

function serve(handler: (req: Request, n: number) => Response | Promise<Response>) {
  let n = 0;
  const server = Bun.serve({ port: 0, fetch: (req) => handler(req, ++n) });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

describe("html extraction", () => {
  test("keeps headings, lists and code; drops scripts and chrome; decodes entities", () => {
    const html = `<html><head><title>Docs &amp; Guides</title><script>alert(1)</script></head><body>
      <nav>Home | About</nav>
      <main><h1>Install</h1><p>Run this &mdash; it&#39;s quick:</p><pre>npm  install\n  ngobe</pre>
      <ul><li>fast</li><li>small</li></ul>${"<p>filler text</p>".repeat(40)}</main><footer>© 2026</footer></body></html>`;
    const { title, text } = htmlToText(html);
    expect(title).toBe("Docs & Guides");
    expect(text).toContain("# Install");
    expect(text).toContain("Run this — it's quick:");
    expect(text).toContain("```\nnpm  install\n  ngobe\n```");
    expect(text).toContain("- fast");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("Home | About");
  });
});

describe("private network guard", () => {
  test.each(["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1"])(
    "%p is not public",
    (addr) => expect(isPublicAddress(addr)).toBe(false),
  );
  test.each(["8.8.8.8", "140.82.112.3", "2606:4700::1111"])("%p is public", (addr) => expect(isPublicAddress(addr)).toBe(true));

  test.each(["http://localhost:8080/", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "http://user:pw@example.com/", "ftp://example.com/"])(
    "refuses %p",
    async (url) => expect(assertPublicUrl(url)).rejects.toThrow(),
  );

  test("fetch_url refuses local services and needs approval for unknown sites", async () => {
    await expect(fetchUrl.run({ url: "http://127.0.0.1:12434/engines/v1/models" }, { cwd: tmpDir() })).rejects.toThrow("non-public");
    expect(fetchUrl.needs!({ url: "https://docs.flutter.dev/ui" })).toBe("none");
    expect(fetchUrl.needs!({ url: "https://registry.npmjs.org/react" })).toBe("none");
    expect(fetchUrl.needs!({ url: "https://random-blog.example/post" })).toBe("approval");
    expect(fetchUrl.needs!({ url: "https://storage.googleapis.com/attacker-bucket/x?d=secret" })).toBe("approval");
  });
});

describe("http client", () => {
  test("revalidates the cache with ETag and serves the cached body on 304", async () => {
    const base = serve((req) =>
      req.headers.get("if-none-match") === '"v1"' ? new Response(null, { status: 304 }) : new Response("payload", { headers: { etag: '"v1"' } }),
    );
    const cacheDir = tmpDir();
    const first = await http(`${base}/x`, { cacheDir });
    const second = await http(`${base}/x`, { cacheDir });
    expect(first).toMatchObject({ body: "payload", fromCache: false });
    expect(second).toMatchObject({ body: "payload", fromCache: true });
  });

  test("serves fresh cache entries without a request", async () => {
    let hits = 0;
    const base = serve(() => {
      hits++;
      return new Response("v");
    });
    const cacheDir = tmpDir();
    await http(`${base}/y`, { cacheDir, ttlMs: 60_000 });
    await http(`${base}/y`, { cacheDir, ttlMs: 60_000 });
    expect(hits).toBe(1);
  });

  test("retries 503 and gives up on 404", async () => {
    const base = serve((req, n) => (new URL(req.url).pathname === "/missing" ? new Response("no", { status: 404 }) : n < 2 ? new Response("busy", { status: 503 }) : new Response("ok")));
    expect((await http(`${base}/flaky`, { retries: 2 })).body).toBe("ok");
    await expect(http(`${base}/missing`)).rejects.toThrow("HTTP 404");
  });

  test("refuses responses over the size limit", async () => {
    const base = serve(() => new Response("x".repeat(5000)));
    await expect(http(`${base}/big`, { maxBytes: 1000 })).rejects.toThrow("larger than");
  });
});

describe("web search", () => {
  test("ranks official sources first and dedupes", async () => {
    const base = serve(() =>
      Response.json({
        results: [
          { title: "Blog post", url: "https://someblog.example/flutter-tips", content: "tips" },
          { title: "Flutter docs", url: "https://docs.flutter.dev/ui/navigation", content: "official" },
          { title: "Blog post again", url: "https://someblog.example/flutter-tips#top", content: "dup" },
        ],
      }),
    );
    const config = testConfig({ searchProviders: ["searxng"], searxngURL: base });
    const r = await webSearch(config, "flutter navigation drawer");
    expect(r.results.map((x) => x.url)).toEqual(["https://docs.flutter.dev/ui/navigation", "https://someblog.example/flutter-tips"]);
    expect(r.results[0].official).toBe(true);
  });

  test("moves to the next provider when one fails, and says so", async () => {
    const base = serve(() => Response.json({ results: [{ title: "t", url: "https://a.example", content: "c" }] }));
    const config = testConfig({ searchProviders: ["brave", "searxng"], braveApiKey: "", searxngURL: base });
    const r = await webSearch(config, "anything");
    expect(r.provider).toBe("searxng");
    expect(r.failures.join()).toContain("BRAVE_API_KEY");
  });

  test("reports when every provider fails", async () => {
    const config = testConfig({ searchProviders: ["searxng"], searxngURL: "http://127.0.0.1:9" });
    await expect(webSearch(config, "x")).rejects.toThrow("Web search failed");
    await expect(webSearch(testConfig(), "x")).rejects.toThrow("No web search provider");
  });
});

describe("official sources", () => {
  test("domain and path-prefix matching", () => {
    expect(urlMatches("https://api.flutter.dev/flutter/widgets", "api.flutter.dev")).toBe(true);
    expect(urlMatches("https://github.com/flutter/flutter/issues", "github.com/flutter")).toBe(true);
    expect(urlMatches("https://github.com/flutterx/evil", "github.com/flutter")).toBe(false);
    expect(urlMatches("https://evilflutter.dev/", "flutter.dev")).toBe(false);
    expect(isOfficialUrl("https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json")).toBe(true);
    expect(isOfficialUrl("https://storage.googleapis.com/someone-else/file")).toBe(false);
  });

  test("finds technologies named in a query", () => {
    expect(techsIn("How do I use Next.js middleware with postgres?")).toEqual(["nextjs", "postgresql"]);
  });
});
