/**
 * Is this pid still the process we recorded? A pid is reused once its process has been reaped,
 * so a signal sent to a remembered pid can hit a stranger. Everything that signals a claude
 * (the runner's retirement, pty-group-kill, the escapee scan, the sweeper's survivor retry)
 * checks the identity recorded at spawn first (#570 r13), and again immediately before each
 * signal (r14).
 *
 * This narrows pid reuse to a very small window; it cannot close it. Between the check and the
 * `kill()` the process can still exit and its pid be reused, and only a native process handle
 * (a pidfd) would make "check and signal" one step. Node and Bun offer none, and none is built
 * here.
 *
 * #581 cp2: `readPidIdentity` below is the ONLY place that asks the OS who a pid is. The numeric
 * start time (`processStartMs`, `procStartMs`) is a projection of that one reading, not a second
 * reader, and every comparison is exact: no window is allowed to widen "the same process".
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** A numeric start time: ms since boot on Linux, epoch ms elsewhere. Null when unreadable. */
export type StartMsReader = (pid: number) => number | null;

/** A raw birth identity (see `readPidIdentity`). Opaque: compare it, do not interpret it. */
export type PidIdentityReader = (pid: number) => string | null;

/** Clock ticks per second of `/proc/<pid>/stat` times. 100 on every Linux build in use. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

/** Seams for the one reader. Production passes nothing; tests name a platform, a fake `/proc` or `ps`. */
export interface IdentityReadDeps {
  platform?: string;
  /** `/proc`; replaced by a fake tree in tests. Linux only. */
  procDir?: string;
  /** Prints `lstart` for a pid in the C locale, or null when `ps` cannot say. Replaced in tests. */
  ps?: (pid: number) => string | null;
}

function psLstart(pid: number): string | null {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    // The C locale fixes the text of the month and weekday names: the same process reads the same
    // string in every environment the daemon is started from.
    env: { ...process.env, LC_ALL: "C" },
    timeout: 2000,
  });
  const out = (r.stdout ?? "").trim();
  return r.status === 0 && out ? out : null;
}

/**
 * A process's birth identity: something a reused pid cannot share with the process that held
 * it before. THE one OS reader.
 *   Linux     field 22 of `/proc/<pid>/stat`, start time in clock ticks since boot, as the raw
 *             digits (a plain file read). Only comparable with a reading from the same boot; a
 *             copy that outlives the daemon is stored with the boot id (`recordedOnAnotherBoot`).
 *   macOS/BSD `ps -o lstart=` in the C locale, the start time to the second (one `ps` spawn, about
 *             10-20 ms, paid once at spawn and once per signal, never per poll). Reuse inside the
 *             same second would need the pid counter to wrap in that second; that is the limit
 *             of this platform and no tolerance is added to it.
 *   null      the pid is gone, the identity cannot be read or parsed (Windows, no `ps`, a
 *             malformed stat), or the pid is not one that names a process.
 * `comm` (field 2 of the stat) may hold spaces and parens, so fields are split after the last
 * `)`, where field 3 is the first.
 */
export function readPidIdentity(pid: number, deps: IdentityReadDeps = {}): string | null {
  const { platform = process.platform, procDir = "/proc", ps = psLstart } = deps;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "win32") return null;
    if (platform === "linux") {
      const stat = readFileSync(`${procDir}/${pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; // field 22
      return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null;
    }
    return ps(pid);
  } catch {
    return null;
  }
}

/**
 * The numeric start time a raw identity stands for, for the places that compare ages (a leader
 * against the processes born after it) and for records that persist a number. Linux: ticks * 10
 * ms since boot (exact, so equal ticks give equal ms). Elsewhere: the epoch ms of the C-locale
 * `lstart` text. Null for a null or unparseable identity.
 */
export function startMsFromIdentity(
  identity: string | null,
  platform: string = process.platform,
): number | null {
  if (identity === null || platform === "win32") return null;
  if (platform === "linux") {
    return /^\d+$/.test(identity) ? (Number(identity) * 1000) / LINUX_CLOCK_TICKS_PER_SECOND : null;
  }
  const ms = Date.parse(identity);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Do two raw identities name one process? Exact, and only when both were read: an unreadable
 * identity is not the same as anything.
 */
export function sameIdentity(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a === b;
}

/**
 * Do two start times, read by `processStartMs`, belong to one process? Exactly equal, on every
 * platform. On Linux two reads of one process are identical and a different process in the next
 * tick differs by 10 ms. On macOS two reads of one process come from the same `lstart` text and
 * are identical, and a process born one second later differs by 1000 ms: a window of any size
 * would only let a recycled pid read as the same process (#570 r14e, H1; #581 cp2). A comparison
 * that authorises a signal must not be given a tolerance.
 */
export function sameStart(a: number, b: number): boolean {
  return a === b;
}

/** Start time of `pid` (see `startMsFromIdentity`), or null when it cannot be read. */
export function processStartMs(pid: number, deps: IdentityReadDeps = {}): number | null {
  return startMsFromIdentity(readPidIdentity(pid, deps), deps.platform);
}

/** `processStartMs` read from a `/proc` tree: the escape scan reads fake trees in its tests. */
export function procStartMs(pid: number, procDir = "/proc"): number | null {
  return processStartMs(pid, { platform: "linux", procDir });
}

export type BootIdReader = () => string | null;

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/** The boot id the test-only Linux switch reports (`linuxUnderTest`). */
export const TEST_BOOT_ID = "00000000-test-boot-id";

/**
 * Test-only switch: `CLAUDECLAW_TEST_PLATFORM=linux` under `bun test` (NODE_ENV=test) makes the
 * boot-id seam defaults below behave as on Linux with a fixed boot id, so the Linux path of the
 * sweep and survivor suites runs on a Mac (#570 r15b). It touches nothing else: `/proc` reads and
 * `sameStart` keep the real platform. Outside a test run it is never read as set.
 */
function linuxUnderTest(): boolean {
  return process.env.NODE_ENV === "test" && process.env.CLAUDECLAW_TEST_PLATFORM === "linux";
}

function bootIdPlatform(): string {
  return linuxUnderTest() ? "linux" : process.platform;
}

/**
 * Linux: the kernel's id for this boot, fixed until the next one. (Not `btime` from `/proc/stat`,
 * which can drift between reads.) Null when it cannot be read.
 */
export function readBootId(path?: string): string | null {
  if (path === undefined && linuxUnderTest()) return TEST_BOOT_ID;
  try {
    const id = readFileSync(path ?? BOOT_ID_PATH, "utf8").trim();
    return id === "" ? null : id;
  } catch {
    return null;
  }
}

/** The id to store beside a start time that outlives this process: Linux only, null elsewhere. */
export function currentBootId(platform: string = bootIdPlatform()): string | null {
  return platform === "linux" ? readBootId() : null;
}

/**
 * Was a persisted start time recorded on a boot other than this one? Then no process it names
 * can be alive: every one of them is gone, and nothing may be signalled on its account. Only
 * Linux needs this (its start times count from boot; macOS `ps lstart` is epoch time). A
 * Linux record with no boot id predates the field and is treated as another boot's. When this
 * boot's id cannot be read the answer is no: nothing can be shown to differ.
 */
export function recordedOnAnotherBoot(
  recorded: string | null | undefined,
  {
    platform = bootIdPlatform(),
    bootId = readBootId,
  }: { platform?: string; bootId?: BootIdReader } = {},
): boolean {
  if (platform !== "linux") return false;
  const now = bootId();
  if (now === null) return false;
  return recorded == null || recorded !== now;
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
