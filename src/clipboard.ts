import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { childEnv } from "./childEnv.js";

/**
 * Ctrl+V in the chat, like Claude Code: an image on the clipboard (a screenshot taken with
 * Cmd+Ctrl+Shift+4, an image copied from a browser) is saved as a PNG and its path goes into the
 * prompt, where it is read like any file the request names. macOS reads it with AppleScript;
 * Linux with wl-paste (Wayland) or xclip (X11). Null when there is no image.
 */
export async function saveClipboardImage(dir: string): Promise<string | null> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `clipboard-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  if (process.platform === "darwin") {
    const script = [
      `set f to (open for access POSIX file ${JSON.stringify(file)} with write permission)`,
      "try",
      "write (the clipboard as «class PNGf») to f",
      "on error",
      "close access f",
      'return "none"',
      "end try",
      "close access f",
      'return "ok"',
    ];
    const out = await run("osascript", script.flatMap((line) => ["-e", line]));
    if (out?.toString().trim() !== "ok") {
      fs.rmSync(file, { force: true });
      return null;
    }
  } else {
    const png = (await run("wl-paste", ["--type", "image/png"])) ?? (await run("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]));
    if (!png?.length) return null;
    fs.writeFileSync(file, png);
  }
  return (fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 0 ? file : null;
}

function run(cmd: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) =>
    execFile(cmd, args, { timeout: 10_000, env: childEnv(), encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout)),
  );
}
