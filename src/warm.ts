/**
 * Keep-warm: Docker Model Runner unloads a model after 5 idle minutes, and its prompt cache with
 * it, so the next request pays a cold start (on a CPU server: the model load plus a minute or more
 * to re-read the prompt). While a chat is open and its user is around, ngobe re-sends the
 * conversation (one token) before that happens; each ping costs a second or two because the
 * server has it all cached. Once the user has been away for keepWarmMinutes, it stops and lets
 * the server free the memory.
 */
export const KEEP_WARM_EVERY_MS = 3.5 * 60_000;

export function shouldKeepWarm(s: { idleMs: number; sinceUserMs: number; busy: boolean; keepWarmMinutes: number }): boolean {
  return s.keepWarmMinutes > 0 && !s.busy && s.sinceUserMs <= s.keepWarmMinutes * 60_000 && s.idleMs >= KEEP_WARM_EVERY_MS;
}
