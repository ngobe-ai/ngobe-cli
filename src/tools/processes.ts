/** Kill a process group started with detached: true (the shell and everything it started). */
export function killGroup(pid: number): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}
