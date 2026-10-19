import {memo, useEffect, useRef, useState} from "react";
import {Box, Text} from "ink";
import type {Mode} from "../config.js";
import {ACCENT} from "../markdown.js";
import {currentFrame, FRAME_MS, useFrame} from "./clock.js";
import {compactLogo, LOGO_HEIGHT, LOGO_WIDTH, logoFrame, paint, SWEEP_FRAMES} from "./logo.js";

export {ACCENT} from "../markdown.js";
export const MODE_COLOR: Record<Mode, string> = {ask: "cyan", plan: "#bb9af7", edit: "gray", auto: "yellow"};

/** Columns per frame while the letters build up on start. */
const REVEAL_STEP = 3;
const INTRO_FRAMES = Math.ceil(LOGO_WIDTH / REVEAL_STEP);
/** Idle: a sweep, then this many frames of rest (the clock stops; nothing re-renders). */
const REST_FRAMES = 75;

export interface HeaderInfo {
  version: string;
  model: string;
  server: string;
  cwd: string;
  mode: Mode;
}

/** Rows the header takes for a terminal of this size (the transcript gets the rest). */
export function headerHeight(rows: number, columns: number): number {
  if (rows < 24 || columns < LOGO_WIDTH + 4) return 2; // one line + divider
  return LOGO_HEIGHT + (columns >= LOGO_WIDTH + 34 ? 0 : 1) + 2; // art (+ info line) + gap + divider
}

/**
 * The animated banner: the letters build up from the left, then a beam of light sweeps across
 * every few seconds. While the agent works the beam runs continuously and the colours flow.
 */
export const Header = memo(function Header({
  info,
  busy,
  rows,
  columns,
}: {
  info: HeaderInfo;
  busy: boolean;
  rows: number;
  columns: number;
}) {
  const start = useRef(currentFrame());
  const [awake, setAwake] = useState(true);
  const frame = useFrame(awake || busy);
  const t = frame - start.current;
  const reveal = Math.min(LOGO_WIDTH, Math.max(0, t) * REVEAL_STEP);

  // Idle: the beam's own frame counter (sweep, rest, sweep …), starting after the intro.
  const period = SWEEP_FRAMES + REST_FRAMES;
  const sweepFrame = busy ? t : Math.max(0, t - INTRO_FRAMES) % period;
  const resting = !busy && t >= INTRO_FRAMES && sweepFrame >= SWEEP_FRAMES;

  // A run wakes the clock; when it ends, the idle cycle carries on from wherever the beam is.
  useEffect(() => {
    if (busy) setAwake(true);
  }, [busy]);
  useEffect(() => {
    if (!resting) return;
    setAwake(false);
    const timer = setTimeout(() => setAwake(true), (period - sweepFrame) * FRAME_MS);
    return () => clearTimeout(timer);
  }, [resting]);

  const compact = rows < 24 || columns < LOGO_WIDTH + 4;
  const divider = <Text color="#3b3149">{"─".repeat(Math.max(0, columns))}</Text>;
  const model = shortModel(info.model);

  if (compact) {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Box paddingX={1} gap={1}>
          <Text bold>{paint(compactLogo(frame, busy))}</Text>
          <Text dimColor wrap="truncate-end">
            v{info.version} · {model} · {info.server}
          </Text>
        </Box>
        {divider}
      </Box>
    );
  }

  // During the intro the beam waits off-screen (frame -1 is before the first sweep starts).
  const art = logoFrame({frame: busy ? t : t < INTRO_FRAMES ? -1 : sweepFrame, busy, reveal});
  const lines = art.map((row) => paint(row));
  const side = columns >= LOGO_WIDTH + 34;
  const infoLines: [string, string][] = [
    ["model", model],
    ["server", info.server],
    ["mode", info.mode],
  ];

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box paddingX={1} gap={3}>
        <Box flexDirection="column" flexShrink={0}>
          {lines.map((l, i) => (
            <Text key={i}>{l}</Text>
          ))}
        </Box>
        {side ? (
          <Box flexDirection="column" flexGrow={1} overflow="hidden">
            <Text>
              <Text bold color={ACCENT}>
                ngobe
              </Text>
              <Text dimColor> v{info.version}</Text>
            </Text>
            <Text dimColor wrap="truncate-end">
              coding agent · runs on your own models
            </Text>
            <Text> </Text>
            {infoLines.map(([k, v]) => (
              <Text key={k} wrap="truncate-end">
                <Text dimColor>{k.padEnd(7)}</Text>
                <Text color={k === "mode" ? MODE_COLOR[info.mode] : undefined}>{v}</Text>
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
      {side ? null : (
        <Box paddingX={1}>
          <Text dimColor wrap="truncate-end">
            v{info.version} · {model} · {info.server} · {info.mode}
          </Text>
        </Box>
      )}
      <Text> </Text>
      {divider}
    </Box>
  );
});

/** "huggingface.co/bartowski/qwen2.5-coder-7b-instruct-gguf:Q4_K_M" → "qwen2.5-coder-7b-instruct-gguf:Q4_K_M" */
export function shortModel(model: string): string {
  return model.split("/").pop() || model;
}
