/**
 * Is this pid still the process we recorded? A pid is reused once its process has been reaped,
 * so a signal sent to a remembered pid can hit a stranger. Everything that signals an untrusted
 * claude (pty-group-kill, the escapee scan, the sweeper's survivor retry) checks the start time
 * recorded at spawn first (#570 r13, B), and again immediately before each signal (r14, B).
 *
 * This narrows pid reuse to a very small window; it cannot close it. Between the check and the
 * `kill()` the process can still exit and its pid be reused, and only a native process handle
 * (a pidfd) would make "check and signal" one step. Node and Bun offer none, and none is built
 * here.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** `ps -o lstart=` has 1 s resolution, so two readings of one process can differ by a second. */
export const START_TIME_TOLERANCE_MS = 2000;

export type StartMsReader = (pid: number) => number | null;

/** Clock ticks per second of `/proc/<pid>/stat` times. 100 on every Linux build in use. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

/** One clock tick. `/proc` start times are boot time plus ticks, so two reads of one process are equal. */
export const LINUX_START_TOLERANCE_MS = 1000 / LINUX_CLOCK_TICKS_PER_SECOND;

/**
 * Do two start times, read by `processStartMs`, belong to one process? On Linux they come from
 * `/proc` and are exact, so the window is one tick: a wider one only lets a recycled pid read as
 * the same process (#570 r14d, H1). Elsewhere they come from `ps -o lstart=`, which has 1 s
 * resolution, and the window is `START_TIME_TOLERANCE_MS`. Every comparison of a recorded start
 * time with a fresh reading goes through here.
 */
export function sameStart(a: number, b: number, platform: string = process.platform): boolean {
  const tolerance = platform === "linux" ? LINUX_START_TOLERANCE_MS : START_TIME_TOLERANCE_MS;
  return Math.abs(a - b) <= tolerance;
}

/**
 * Linux: the start time from field 22 of `/proc/<pid>/stat` (ticks since boot), in ms since boot.
 * A wall-clock step moves `ps -o lstart=` but not this. The value is only comparable with another
 * read on the same boot, which is all a recorded start time is compared with. Null when the stat
 * cannot be read or parsed. `comm` (field 2) may hold spaces and parens, so fields are split
 * after the last `)`, where field 3 is the first.
 */
export function procStartMs(pid: number, procDir = "/proc"): number | null {
  try {
    const stat = readFileSync(`${procDir}/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]); // field 22 is index 19 after field 3
    return Number.isFinite(ticks) ? (ticks * 1000) / LINUX_CLOCK_TICKS_PER_SECOND : null;
  } catch {
    return null;
  }
}

/**
 * Start time of `pid`, or null when it cannot be read. Linux: `/proc` (monotonic, 10 ms
 * resolution). Elsewhere: `ps -o lstart=` (1 s resolution).
 */
export function processStartMs(pid: number): number | null {
  if (process.platform === "linux") return procStartMs(pid);
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
  return sameStart(now, expectedStartMs) ? "same" : "recycled";
}
