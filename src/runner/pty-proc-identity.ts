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
import { readFileSync, readdirSync } from "node:fs";

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
  /** Prints `pgid lstart` for one pid (the snapshot's `ps`). Replaced in tests. */
  psSnapshot?: (pid: number) => string | null;
  /** Prints `pid pgid stat lstart` for every process (the member listing's `ps`). Replaced in tests. */
  psAll?: (timeoutMs: number) => string | null;
  /**
   * Upper bound on any `ps` this call may start, in ms (default 2000). A caller that owns an
   * absolute deadline passes what is left of it; zero or less starts nothing and reads as null.
   */
  psTimeoutMs?: number;
}

const PS_TIMEOUT_MS = 2000;

/** One bounded `ps` in the C locale: the same process reads the same text in every environment. */
function runPs(args: string[], timeoutMs: number): string | null {
  if (!(timeoutMs > 0)) return null; // no time left: do not start a subprocess
  const r = spawnSync("ps", args, {
    encoding: "utf8",
    // The C locale fixes the text of the month and weekday names: the same process reads the same
    // string in every environment the daemon is started from.
    env: { ...process.env, LC_ALL: "C" },
    timeout: Math.min(PS_TIMEOUT_MS, timeoutMs),
  });
  return r.status === 0 ? (r.stdout ?? "") : null;
}

function psLstart(pid: number, timeoutMs = PS_TIMEOUT_MS): string | null {
  const out = (runPs(["-o", "lstart=", "-p", String(pid)], timeoutMs) ?? "").trim();
  return out || null;
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
  const { platform = process.platform, procDir = "/proc", psTimeoutMs = PS_TIMEOUT_MS } = deps;
  const ps = deps.ps ?? ((p: number) => psLstart(p, psTimeoutMs));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "win32") return null;
    if (platform === "linux")
      return parseLinuxStat(readFileSync(`${procDir}/${pid}/stat`, "utf8"))?.identity ?? null;
    return ps(pid);
  } catch {
    return null;
  }
}

/** What one reading of a process says: who it is (its birth) and which group it is in. */
export interface PidSnapshot {
  identity: string;
  pgid: number;
}

/** A reader of a pid's process group id. Replaced in tests. */
export type PgidReader = (pid: number) => number | null;

interface LinuxStat {
  state: string;
  pgid: number;
  identity: string;
}

/** Fields of a `/proc/<pid>/stat` line; `comm` may hold spaces and parens, so split after the last `)`. */
function parseLinuxStat(stat: string): LinuxStat | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const state = fields[0];
  const pgid = Number(fields[2]);
  const ticks = fields[19]; // field 22
  if (!state || !Number.isInteger(pgid) || ticks === undefined || !/^\d+$/.test(ticks)) return null;
  return { state, pgid, identity: ticks };
}

/**
 * A process's identity AND its process group id from ONE reading, so the two cannot belong to
 * different processes (#581 cp8, L1). The identity is the one `readPidIdentity` reports: Linux
 * reads one `/proc/<pid>/stat`; macOS runs one bounded `ps -o pgid=,lstart=`.
 */
export function readPidSnapshot(pid: number, deps: IdentityReadDeps = {}): PidSnapshot | null {
  const { platform = process.platform, procDir = "/proc", psTimeoutMs = PS_TIMEOUT_MS } = deps;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "win32") return null;
    if (platform === "linux") {
      const parsed = parseLinuxStat(readFileSync(`${procDir}/${pid}/stat`, "utf8"));
      return parsed ? { identity: parsed.identity, pgid: parsed.pgid } : null;
    }
    const out =
      deps.psSnapshot?.(pid) ?? runPs(["-o", "pgid=,lstart=", "-p", String(pid)], psTimeoutMs);
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(out ?? "");
    return m?.[1] && m[2] ? { identity: m[2], pgid: Number(m[1]) } : null;
  } catch {
    return null;
  }
}

/** The process group id of `pid` now, or null when it cannot be read. */
export function readPgid(pid: number, deps: IdentityReadDeps = {}): number | null {
  return readPidSnapshot(pid, deps)?.pgid ?? null;
}

/** A process that was positively identified (by its birth) as a member of a process group. */
export interface GroupMember {
  pid: number;
  /** Raw birth identity, as `readPidIdentity` reports it. */
  identity: string;
}

/** What one listing of a group saw. `complete` is false when part of the table could not be read. */
export interface GroupMembersReading {
  members: GroupMember[];
  complete: boolean;
}

/** Lists the live members of process group `pgid`, inside the absolute `deadlineAt`. Replaced in tests. */
export type GroupMembersReader = (pgid: number, deadlineAt: number) => GroupMembersReading;

/**
 * The live (non-zombie) members of process group `pgid`, each with the birth identity read in the
 * SAME reading that showed its group, so a member is never a stranger that took a dead member's
 * pid between two reads. Bounded by `deadlineAt`: Linux checks it as it walks `/proc`, and macOS
 * gives its one `ps` what is left of it. A table that cannot be read (or the deadline) returns
 * what was seen with `complete: false`; the caller treats it as positive evidence only.
 */
export function readGroupMembers(
  pgid: number,
  deadlineAt: number,
  deps: IdentityReadDeps & { now?: () => number } = {},
): GroupMembersReading {
  const { platform = process.platform, procDir = "/proc", now = Date.now } = deps;
  const members: GroupMember[] = [];
  if (!Number.isInteger(pgid) || pgid <= 1 || platform === "win32") {
    return { members, complete: false };
  }
  if (platform === "linux") {
    let names: string[];
    try {
      names = readdirSync(procDir);
    } catch {
      return { members, complete: false };
    }
    let complete = true;
    let walked = 0;
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      if (++walked % 64 === 0 && now() >= deadlineAt) return { members, complete: false };
      let stat: LinuxStat | null;
      try {
        stat = parseLinuxStat(readFileSync(`${procDir}/${name}/stat`, "utf8"));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ESRCH") complete = false;
        continue;
      }
      if (stat === null) {
        complete = false;
        continue;
      }
      if (stat.pgid !== pgid || stat.state === "Z" || stat.state === "X") continue;
      members.push({ pid: Number(name), identity: stat.identity });
    }
    return { members, complete };
  }
  const left = deadlineAt - now();
  const out = deps.psAll?.(left) ?? runPs(["-axo", "pid=,pgid=,stat=,lstart="], left);
  if (out === null) return { members, complete: false };
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m || Number(m[2]) !== pgid || m[3]?.startsWith("Z")) continue;
    members.push({ pid: Number(m[1]), identity: m[4] ?? "" });
  }
  return { members, complete: true };
}

/** Do two member lists name the same process? Exact on both pid and raw identity. */
export function sameMember(a: GroupMember, b: GroupMember): boolean {
  return a.pid === b.pid && sameIdentity(a.identity, b.identity);
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
