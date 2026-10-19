import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { closeTunnel, ensureTunnel, portOpen, sshArgs, tunnelSpec } from "../src/tunnel.js";
import { tmpDir } from "./helpers.js";

const base = { baseURL: "http://127.0.0.1:12435/engines/v1", sshTunnel: "root@203.0.113.7:30620", sshTunnelTarget: "127.0.0.1:12434" };

describe("tunnel settings", () => {
  test("parses destination, port and target", () => {
    expect(tunnelSpec(base)).toEqual({ destination: "root@203.0.113.7", sshPort: 30620, localHost: "127.0.0.1", localPort: 12435, target: "127.0.0.1:12434" });
    expect(tunnelSpec({ ...base, sshTunnel: "my-server", sshTunnelTarget: "" })).toMatchObject({ destination: "my-server", sshPort: undefined, target: "127.0.0.1:12435" });
    expect(tunnelSpec({ ...base, sshTunnel: "" })).toBeNull();
  });

  test("builds a batch-mode ssh command with only a local forward", () => {
    expect(sshArgs(tunnelSpec(base)!)).toEqual([
      "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
      "-L", "127.0.0.1:12435:127.0.0.1:12434", "-p", "30620", "root@203.0.113.7",
    ]);
  });

  test.each([
    [{ sshTunnel: "-oProxyCommand=evil" }, "user@host"],
    [{ sshTunnel: "root@host; rm -rf ~" }, "user@host"],
    [{ baseURL: "https://models.example.com/v1" }, "must point at this machine"],
    [{ sshTunnelTarget: "127.0.0.1" }, "host:port"],
  ])("rejects %p", (override, message) => {
    expect(() => tunnelSpec({ ...base, ...override })).toThrow(message);
  });
});

describe("opening the tunnel", () => {
  const realPath = process.env.PATH;
  let servers: net.Server[] = [];
  afterEach(() => {
    closeTunnel();
    process.env.PATH = realPath;
    for (const s of servers) s.close();
    servers = [];
  });

  /** Put a stand-in `ssh` first on PATH. */
  function fakeSsh(script: string) {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "ssh"), `#!/usr/bin/env bun\n${script}\n`, { mode: 0o755 });
    process.env.PATH = `${dir}:${realPath}`;
  }

  async function freePort(): Promise<number> {
    const s = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    const port = (s.address() as net.AddressInfo).port;
    await new Promise((r) => s.close(r));
    return port;
  }

  test("reuses a port something already serves", async () => {
    const s = net.createServer().listen(0, "127.0.0.1");
    servers.push(s);
    await new Promise((r) => s.once("listening", r));
    const port = (s.address() as net.AddressInfo).port;
    fakeSsh("process.exit(99) // must not be called");
    expect(await ensureTunnel({ ...base, baseURL: `http://127.0.0.1:${port}/v1` })).toContain("already open");
  });

  test("starts ssh and waits until the forwarded port answers; closes it on request", async () => {
    const port = await freePort();
    // Stand-in for ssh -L: listen on the requested local port and stay up.
    fakeSsh(`const spec = process.argv[process.argv.indexOf("-L") + 1]; const port = Number(spec.split(":")[1]);
setTimeout(() => require("node:net").createServer().listen(port, "127.0.0.1"), 300);
setInterval(() => {}, 1000);`);
    expect(await ensureTunnel({ ...base, baseURL: `http://127.0.0.1:${port}/v1` })).toContain("opened");
    expect(await portOpen("127.0.0.1", port)).toBe(true);
    closeTunnel();
    await Bun.sleep(300);
    expect(await portOpen("127.0.0.1", port)).toBe(false);
  });

  test("retries once when the connection times out", async () => {
    const port = await freePort();
    const counter = path.join(tmpDir(), "attempts");
    fakeSsh(`const fs = require("node:fs"); const n = Number(fs.existsSync(${JSON.stringify(counter)}) ? fs.readFileSync(${JSON.stringify(counter)}, "utf8") : 0) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
if (n === 1) { console.error("ssh: connect to host 203.0.113.7 port 30620: Operation timed out"); process.exit(255); }
const spec = process.argv[process.argv.indexOf("-L") + 1]; require("node:net").createServer().listen(Number(spec.split(":")[1]), "127.0.0.1"); setInterval(() => {}, 1000);`);
    expect(await ensureTunnel({ ...base, baseURL: `http://127.0.0.1:${port}/v1` })).toContain("opened");
    expect(fs.readFileSync(counter, "utf8")).toBe("2");
  });

  test("explains a refused key", async () => {
    const port = await freePort();
    fakeSsh(`console.error("root@203.0.113.7: Permission denied (publickey)."); process.exit(255);`);
    await expect(ensureTunnel({ ...base, baseURL: `http://127.0.0.1:${port}/v1` })).rejects.toThrow("ssh-copy-id -p 30620 root@203.0.113.7");
  });

  test("explains an unknown host key", async () => {
    const port = await freePort();
    fakeSsh(`console.error("Host key verification failed."); process.exit(255);`);
    await expect(ensureTunnel({ ...base, baseURL: `http://127.0.0.1:${port}/v1` })).rejects.toThrow("accept the server's host key");
  });
});

test("a process that opened a tunnel still exits, and takes the tunnel with it", async () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "ssh"),
    `#!/usr/bin/env bun\nconst spec = process.argv[process.argv.indexOf("-L") + 1];\nrequire("node:net").createServer().listen(Number(spec.split(":")[1]), "127.0.0.1");\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o755 },
  );
  const probe = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => probe.once("listening", r));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise((r) => probe.close(r));
  const script = path.join(dir, "open.ts");
  fs.writeFileSync(
    script,
    `import { ensureTunnel } from ${JSON.stringify(path.join(import.meta.dir, "../src/tunnel.ts"))};\nconsole.log(await ensureTunnel({ baseURL: "http://127.0.0.1:${port}/v1", sshTunnel: "u@h", sshTunnelTarget: "127.0.0.1:1" }));\n`,
  );
  const started = Date.now();
  const proc = Bun.spawn(["bun", script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdout: "pipe" });
  const exited = await Promise.race([proc.exited, Bun.sleep(8000).then(() => "timeout")]);
  if (exited === "timeout") proc.kill();
  expect(exited).toBe(0);
  expect(Date.now() - started).toBeLessThan(8000);
  await Bun.sleep(300);
  expect(await portOpen("127.0.0.1", port)).toBe(false); // the stand-in ssh was closed on exit
}, 15_000);
