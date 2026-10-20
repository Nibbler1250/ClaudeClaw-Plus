/**
 * Is this pid still the process we recorded? A pid is reused once its process has been reaped,
 * so a signal sent to a remembered pid can hit a stranger. Everything that signals an untrusted
 * claude (pty-group-kill, the escapee scan, the sweeper's survivor retry) checks the start time
 * recorded at spawn first (#570 r13, B).
 */

import { spawnSync } from "node:child_process";

/** `ps -o lstart=` has 1 s resolution, so two readings of one process can differ by a second. */
export const START_TIME_TOLERANCE_MS = 2000;

export type StartMsReader = (pid: number) => number | null;

/** Start time of `pid` from `ps -o lstart=` (1 s resolution), or null when it cannot be read. */
export function processStartMs(pid: number): number | null {
  try {
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (out.status !== 0) return null;
    const ms = Date.parse(out.stdout.trim());
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/** A reader that asks `ps` once per pid: for one sweep pass, which looks at the same pid several times. */
export function cachedStartMs(read: StartMsReader = processStartMs): StartMsReader {
  const seen = new Map<number, number | null>();
  return (pid) => {
    if (!seen.has(pid)) seen.set(pid, read(pid));
    return seen.get(pid) ?? null;
  };
}

/**
 * What a recorded pid is now: the process we recorded (`same`), nothing (`gone`), another
 * process that was given the pid after ours was reaped (`recycled`), or a pid that exists while
 * either start time is unknown (`unknown`: it cannot be told from a stranger).
 */
export type PidIdentity = "same" | "gone" | "recycled" | "unknown";

export function pidIdentity(
  pid: number,
  expectedStartMs: number | null | undefined,
  { exists, read }: { exists: (pid: number) => boolean; read: StartMsReader },
): PidIdentity {
  if (!exists(pid)) return "gone";
  const now = read(pid);
  if (expectedStartMs == null || now === null) return "unknown";
  return Math.abs(now - expectedStartMs) > START_TIME_TOLERANCE_MS ? "recycled" : "same";
}
