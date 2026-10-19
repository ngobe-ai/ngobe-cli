import { useSyncExternalStore } from "react";

/**
 * One animation clock for the whole screen: the banner, the spinner line and running tool
 * dots all tick on the same interval, so each tick is one ink frame, not three. It only runs
 * while something animated is on screen.
 */
export const FRAME_MS = 90;

let frame = Math.floor(Date.now() / FRAME_MS);
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(fn: () => void) {
  subscribers.add(fn);
  if (!timer) {
    frame = Math.floor(Date.now() / FRAME_MS);
    timer = setInterval(() => {
      frame = Math.floor(Date.now() / FRAME_MS);
      for (const s of subscribers) s();
    }, FRAME_MS);
    timer.unref?.();
  }
  return () => {
    subscribers.delete(fn);
    if (!subscribers.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const idle = () => () => {};

/** The current frame number (time-based, so it's the same everywhere); ticks only while `active`. */
export function useFrame(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : idle, () => frame);
}

export function currentFrame(): number {
  return Math.floor(Date.now() / FRAME_MS);
}
