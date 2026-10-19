import chalk from "chalk";

/**
 * The animated NGOBE banner: ANSI Shadow letters painted with a sunset gradient. Faces (█) get
 * the gradient, the box-drawing "shadow" strokes a darker shade of it, and a beam of light sweeps
 * across now and then (continuously, with the colours flowing, while the agent works). Pure
 * functions of the frame number, so the component only has to tick and the tests can check frames.
 */

const LETTERS: Record<string, string[]> = {
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  G: [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  O: [" ██████╗ ", "██╔═══██╗", "██║   ██║", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  B: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██████╔╝", "╚═════╝ "],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
};

export const LOGO: string[] = LETTERS.N.map((_, row) => [..."NGOBE"].map((ch) => LETTERS[ch][row]).join(""));
export const LOGO_WIDTH = Math.max(...LOGO.map((l) => [...l].length));
export const LOGO_HEIGHT = LOGO.length;

/** Sunset: gold → orange → coral → magenta → violet. */
const STOPS: [number, number, number][] = [
  [255, 200, 87],
  [255, 140, 66],
  [255, 94, 98],
  [232, 67, 147],
  [142, 68, 173],
];
const LIGHT: [number, number, number] = [255, 246, 220];

type Rgb = [number, number, number];

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as Rgb;
}

/** The gradient at t (wraps around, so a moving offset flows smoothly). */
export function gradientAt(t: number): Rgb {
  const x = ((t % 1) + 1) % 1;
  // Out along the stops and back, so the wrap point has no seam.
  const u = x < 0.5 ? x * 2 : (1 - x) * 2;
  const pos = u * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(pos));
  return mix(STOPS[i], STOPS[i + 1], pos - i);
}

const hex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
const SHADOW_CHARS = new Set([..."╗╔╝╚║═"]);

export interface Segment {
  text: string;
  /** undefined for spaces (left uncoloured so the art stays aligned on every terminal). */
  color?: string;
}

export interface LogoFrame {
  /** Animation frame (one tick ≈ 80 ms). */
  frame: number;
  /** Working: the beam sweeps continuously and the colours flow. */
  busy: boolean;
  /** Columns revealed so far (the intro builds the letters up from the left); default all. */
  reveal?: number;
}

/** Frames per beam sweep, and the frame the beam is at (null between idle sweeps). */
export const SWEEP_FRAMES = 22;
const BEAM_HALF = 3.5;

export function beamColumn(frame: number, busy: boolean): number | null {
  // Idle: one sweep, then a rest of ~6 s. Busy: back to back.
  const period = busy ? SWEEP_FRAMES : SWEEP_FRAMES + 75;
  const f = frame % period;
  if (f >= SWEEP_FRAMES) return null;
  return -BEAM_HALF * 2 + (f / (SWEEP_FRAMES - 1)) * (LOGO_WIDTH + BEAM_HALF * 4);
}

/** Is the banner static at this frame (so the component can stop ticking until the next sweep)? */
export function isResting(frame: number, busy: boolean): boolean {
  return beamColumn(frame, busy) === null;
}

/** The banner at one frame, as runs of same-coloured text per row. */
export function logoFrame({ frame, busy, reveal = LOGO_WIDTH }: LogoFrame): Segment[][] {
  const beam = beamColumn(frame, busy);
  const flow = busy ? frame / 60 : 0;
  // Quantized to whole columns of colour so neighbouring cells merge into one <Text>.
  return LOGO.map((line, row) => {
    const segments: Segment[] = [];
    [...line].forEach((ch, col) => {
      let color: string | undefined;
      if (ch !== " " && col < reveal) {
        // A slight diagonal (rows shift the gradient) reads as light from the top left.
        let c = gradientAt(flow + (col + row * 1.5) / (LOGO_WIDTH * 1.6));
        if (SHADOW_CHARS.has(ch)) c = mix(c, [40, 22, 52], 0.45);
        if (beam !== null) {
          const d = Math.abs(col - row * 0.6 - beam);
          if (d < BEAM_HALF) c = mix(c, LIGHT, (1 - d / BEAM_HALF) * (SHADOW_CHARS.has(ch) ? 0.5 : 0.85));
        }
        color = hex(c);
      }
      const text = col < reveal ? ch : " ";
      const last = segments[segments.length - 1];
      if (last && last.color === color) last.text += text;
      else segments.push({ text, color });
    });
    return segments;
  });
}

/** The one-line banner for short terminals: gradient letters, no art. */
export function compactLogo(frame: number, busy: boolean): Segment[] {
  const flow = busy ? frame / 30 : 0;
  return [..."NGOBE"].map((ch, i) => ({ text: ch, color: hex(gradientAt(flow + i / 6)) }));
}

/** Segments as one terminal string (chalk downgrades the colours where truecolor isn't supported). */
export function paint(segments: Segment[]): string {
  return segments.map((s) => (s.color ? chalk.hex(s.color)(s.text) : s.text)).join("");
}
