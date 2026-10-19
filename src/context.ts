import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Message } from "./types.js";

/** Keep head and tail of long outputs; the middle is rarely what the model needs. */
export function truncate(s: string, max = 20_000): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n\n... [${s.length - max} characters truncated] ...\n\n${s.slice(-half)}`;
}

export async function loadProjectInstructions(cwd: string): Promise<string> {
  try {
    return await fs.readFile(path.join(cwd, "AGENTS.md"), "utf8");
  } catch {
    return "";
  }
}

export function buildSystemPrompt(cwd: string, instructions: string): string {
  const base = `You are a coding agent running in a terminal, working inside the user's project.

Environment:
- Working directory: ${cwd}
- Platform: ${os.platform()}

How to work:
- Explore before changing anything: use glob and grep to find files, then read_file.
- Make changes with edit_file (exact string replacement). old_str must match exactly once; include enough surrounding context.
- Use write_file only for new files or full rewrites.
- Verify your work by running the project's tests or build with bash.
- Call tools using the provided tool-calling interface only. Never describe a tool call in plain text.
- Be concise. When the task is done, reply with a short summary and no tool calls.`;
  return instructions ? `${base}\n\nProject instructions (AGENTS.md):\n${instructions}` : base;
}

/**
 * Cheap context management: when the history gets too large, blank out the oldest
 * tool outputs. Message structure is preserved so tool_call/tool pairs stay valid.
 * Replace this with LLM-based summarization later.
 */
export function trimHistory(messages: Message[], maxChars = 200_000): void {
  const size = () =>
    messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
  if (size() <= maxChars) return;
  for (const m of messages) {
    if (size() <= maxChars) return;
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > 300) {
      m.content = "[older tool output removed to save context]";
    }
  }
}
