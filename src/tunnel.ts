import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import type { Config } from "./config.js";

/**
 * Reach a model server that only listens on its own localhost (Docker Model Runner has no
 * authentication, so it must not be published) through an SSH tunnel:
 *
 *   ssh -N -L 127.0.0.1:<local port of baseURL>:<sshTunnelTarget> <sshTunnel>
 *
 * Opened on first use, reused if something already serves the local port, reopened after a
 * drop, closed when ngobe exits. Batch mode: key authentication only, no password prompts, and
 * an unknown host key is refused rather than accepted.
 */

export interface TunnelSpec {
  /** user@host (or a ~/.ssh/config alias) */
  destination: string;
  sshPort?: number;
  localHost: string;
  localPort: number;
  /** host:port as seen from the SSH server */
  target: string;
}

const DESTINATION = /^(?!-)[\w.-]+(@[\w.-]+|@\[[0-9a-fA-F:]+\])?$/;

/** Parse the tunnel settings; null when no tunnel is configured. */
export function tunnelSpec(config: Pick<Config, "baseURL" | "sshTunnel" | "sshTunnelTarget">): TunnelSpec | null {
  if (!config.sshTunnel) return null;
  const m = /^(.*?)(?::(\d+))?$/.exec(config.sshTunnel.trim());
  const destination = m?.[1] ?? "";
  if (!DESTINATION.test(destination)) throw new Error(`sshTunnel must look like user@host or user@host:port (got "${config.sshTunnel}")`);
  const url = new URL(config.baseURL);
  const localHost = url.hostname.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(localHost)) {
    throw new Error(`with sshTunnel, baseURL must point at this machine (127.0.0.1), not ${url.hostname}`);
  }
  const localPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const target = config.sshTunnelTarget || `127.0.0.1:${localPort}`;
  if (!/^[\w.-]+:\d+$|^\[[0-9a-fA-F:]+\]:\d+$/.test(target)) throw new Error(`sshTunnelTarget must be host:port (got "${target}")`);
  return { destination, sshPort: m?.[2] ? Number(m[2]) : undefined, localHost: localHost === "localhost" ? "127.0.0.1" : localHost, localPort, target };
}

export function sshArgs(spec: TunnelSpec): string[] {
  return [
    "-N",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-L", `${spec.localHost.includes(":") ? `[${spec.localHost}]` : spec.localHost}:${spec.localPort}:${spec.target}`,
    ...(spec.sshPort ? ["-p", String(spec.sshPort)] : []),
    spec.destination,
  ];
}

/** Does something accept TCP connections on host:port? */
export function portOpen(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

let child: ChildProcess | null = null;

/** Make sure the tunnel is up (opening it if needed). Returns a short status line. */
export async function ensureTunnel(config: Pick<Config, "baseURL" | "sshTunnel" | "sshTunnelTarget">): Promise<string | null> {
  const spec = tunnelSpec(config);
  if (!spec) return null;
  const via = `SSH tunnel ${spec.destination}${spec.sshPort ? `:${spec.sshPort}` : ""} → ${spec.target}`;
  if (await portOpen(spec.localHost, spec.localPort)) return `${via} (already open on ${spec.localPort})`;

  closeTunnel();
  let stderr = "";
  const proc = spawn("ssh", sshArgs(spec), { stdio: ["ignore", "ignore", "pipe"] });
  child = proc;
  proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  let exited = false;
  proc.once("exit", () => {
    exited = true;
    if (child === proc) child = null;
  });
  proc.once("error", (err) => {
    exited = true;
    stderr += err.message;
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exited) break;
    if (await portOpen(spec.localHost, spec.localPort, 500)) {
      // Up: stop holding ngobe open. The exit and signal hooks below still close it.
      proc.stderr?.destroy();
      proc.unref();
      return `${via} (opened on ${spec.localPort})`;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  closeTunnel();
  const reason = stderr.trim().split("\n").pop() || "no response within 20s";
  const hint = /Permission denied/.test(stderr)
    ? ` Set up key login first: ssh-copy-id${spec.sshPort ? ` -p ${spec.sshPort}` : ""} ${spec.destination}`
    : /Host key verification failed/.test(stderr)
      ? ` Connect once by hand to check and accept the server's host key: ssh${spec.sshPort ? ` -p ${spec.sshPort}` : ""} ${spec.destination}`
      : /Address already in use|forwarding failed/i.test(stderr)
        ? ` Port ${spec.localPort} is taken on this machine; pick another in baseURL.`
        : "";
  throw new Error(`could not open the ${via}: ${reason}.${hint}`);
}

export function closeTunnel(): void {
  if (child && child.exitCode === null) child.kill();
  child = null;
}

// The tunnel lives exactly as long as this ngobe process. (Ctrl+C in a terminal already reaches
// ssh, which shares the process group; a SIGTERM or hang-up sent to ngobe alone would not.)
process.once("exit", closeTunnel);
for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  process.once(signal, () => {
    closeTunnel();
    process.exit(code);
  });
}
