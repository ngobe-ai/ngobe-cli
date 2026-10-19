import chalk from "chalk";

/**
 * Just enough markdown for a terminal, one line at a time (replies stream line by line):
 * headings, bullets, rules, code blocks (indented, fence markers hidden), `code`, **bold** and
 * [links](url). chalk drops the colours where the terminal has none.
 */

export const ACCENT = "#ff8c42";
const CODE = "#bb9af7";

export interface MdState {
  fenced: boolean;
}

/** One rendered line, or null for a line that isn't shown (a code fence marker). */
export function mdLine(line: string, state: MdState): string | null {
  if (/^\s*```/.test(line)) {
    state.fenced = !state.fenced;
    return null;
  }
  if (state.fenced) return chalk.hex(CODE)(`  ${line}`);
  const heading = /^#{1,6}\s+(.*)$/.exec(line);
  if (heading) return chalk.bold.hex(ACCENT)(inline(heading[1]));
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return chalk.dim("─".repeat(40));
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}• ${inline(bullet[2])}`;
  return inline(line);
}

/** A whole reply. */
export function renderMarkdown(text: string): string[] {
  const state = { fenced: false };
  return text.split("\n").flatMap((l) => {
    const r = mdLine(l, state);
    return r === null ? [] : [r];
  });
}

export function inline(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, (_m, c: string) => chalk.hex(CODE)(c))
    .replace(/\*\*([^*\n]+)\*\*/g, (_m, b: string) => chalk.bold(b))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => `${t} ${chalk.dim(`(${u})`)}`);
}
