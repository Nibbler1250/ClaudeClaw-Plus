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
 *
 * macOS (#581, after #596): the identity is the microsecond start time libproc reports, the reader
 * the bus ownership guard uses (`./libproc`), and no `ps` is spawned to read it. #596's rule holds
 * here too: an identity that is only second-precise never authorises a signal. Off libproc there
 * is no macOS identity at all (null: "cannot tell"), and an identity persisted by an older daemon
 * (the second-precise `ps lstart` text, or its whole-second number) that matches to the second is
 * `unknown` (`compareIdentity`, `compareStartMs`), never the same process and never another one.
 */

import { readFileSync, readdirSync } from "node:fs";
import {
  type BsdInfo,
  type KinfoProc,
  kinfoProc,
  libprocAvailable,
  libprocBsdInfo,
  libprocGroupPids,
  SZOMB,
  type StartTime,
} from "./libproc.js";

/** A numeric start time: ms since boot on Linux, epoch ms elsewhere. Null when unreadable. */
export type StartMsReader = (pid: number) => number | null;

/** A raw birth identity (see `readPidIdentity`). Opaque: compare it, do not interpret it. */
export type PidIdentityReader = (pid: number) => string | null;

/** Clock ticks per second of `/proc/<pid>/stat` times. 100 on every Linux build in use. */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

/** Seams for the one reader. Production passes nothing; tests name a platform, a fake `/proc` or libproc. */
export interface IdentityReadDeps {
  platform?: string;
  /** `/proc`; replaced by a fake tree in tests. Linux only. */
  procDir?: string;
  /** macOS: one libproc `proc_bsdinfo` reading of a pid, or null. Replaced in tests. */
  bsdInfo?: (pid: number) => BsdInfo | null;
  /** macOS: the pids of one process group, zombies included, or null. Replaced in tests. */
  groupPids?: (pgid: number) => number[] | null;
  /**
   * macOS: one `sysctl(KERN_PROC_PID)` reading of a pid libproc would not answer for: a zombie
   * (read, and so marked), `"gone"`, or null when it cannot be read. Replaced in tests.
   */
  kinfo?: (pid: number) => KinfoProc | "gone" | null;
}

let warnedNoLibproc = false;

/** libproc's reading, said once when this platform cannot give one (then nothing is signalled). */
function defaultBsdInfo(pid: number): BsdInfo | null {
  if (!warnedNoLibproc && !libprocAvailable()) {
    warnedNoLibproc = true;
    console.warn(
      "[pty-proc-identity] libproc is unavailable: no process identity can be read on this platform, so no claude will be signalled",
    );
  }
  return libprocBsdInfo(pid);
}

/** The macOS identity: libproc's start time as `<epoch seconds>.<microseconds, six digits>`. */
function darwinIdentity(start: StartTime): string {
  return `${start.sec}.${String(start.usec).padStart(6, "0")}`;
}

const DARWIN_IDENTITY = /^(\d+)\.(\d{6})$/;

/** One macOS reading of a pid: who it is, its group, and whether it is a zombie. */
interface DarwinReading {
  identity: string;
  pgid: number;
  zombie: boolean;
}

/**
 * libproc's reading of `pid` (#596's reader); for a pid libproc does not answer, the kernel's
 * `kinfo_proc`, which tells a zombie (still holding its pid, so still that process) from a pid that
 * is gone. Both report the same start time. `"gone"`: no such process. Null: cannot be read.
 */
function readDarwin(pid: number, deps: IdentityReadDeps): DarwinReading | "gone" | null {
  const info = (deps.bsdInfo ?? defaultBsdInfo)(pid);
  if (info) {
    return { identity: darwinIdentity(info.start), pgid: info.pgid, zombie: info.status === SZOMB };
  }
  const k = (deps.kinfo ?? kinfoProc)(pid);
  if (k === null) return null;
  if (k === "gone") return "gone";
  return { identity: darwinIdentity(k.start), pgid: k.pgid, zombie: k.zombie };
}

const readable = (r: DarwinReading | "gone" | null): DarwinReading | null =>
  r === null || r === "gone" ? null : r;

/**
 * A process's birth identity: something a reused pid cannot share with the process that held
 * it before. THE one OS reader.
 *   Linux     field 22 of `/proc/<pid>/stat`, start time in clock ticks since boot, as the raw
 *             digits (a plain file read). Only comparable with a reading from the same boot; a
 *             copy that outlives the daemon is stored with the boot id (`recordedOnAnotherBoot`).
 *   macOS/BSD libproc's start time to the microsecond, `<sec>.<usec>` (one `proc_pidinfo` call,
 *             no subprocess). libproc does not answer for a zombie, which still holds its pid:
 *             the kernel's `kinfo_proc` gives the same start time for it (`readDarwin`).
 *   null      the pid is gone, the identity cannot be read or parsed (Windows, no libproc, a
 *             malformed stat), or the pid is not one that names a process.
 * `comm` (field 2 of the stat) may hold spaces and parens, so fields are split after the last
 * `)`, where field 3 is the first.
 */
export function readPidIdentity(pid: number, deps: IdentityReadDeps = {}): string | null {
  const { platform = process.platform, procDir = "/proc" } = deps;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "win32") return null;
    if (platform === "linux")
      return parseLinuxStat(readFileSync(`${procDir}/${pid}/stat`, "utf8"))?.identity ?? null;
    return readable(readDarwin(pid, deps))?.identity ?? null;
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
 * reads one `/proc/<pid>/stat`; macOS makes one libproc call (`readDarwin`).
 */
export function readPidSnapshot(pid: number, deps: IdentityReadDeps = {}): PidSnapshot | null {
  const { platform = process.platform, procDir = "/proc" } = deps;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "win32") return null;
    if (platform === "linux") {
      const parsed = parseLinuxStat(readFileSync(`${procDir}/${pid}/stat`, "utf8"));
      return parsed ? { identity: parsed.identity, pgid: parsed.pgid } : null;
    }
    const r = readable(readDarwin(pid, deps));
    return r ? { identity: r.identity, pgid: r.pgid } : null;
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
 * between the libproc reads of the group's pids. A table that cannot be read (or the deadline)
 * returns what was seen with `complete: false`; the caller treats it as positive evidence only.
 * macOS: libproc lists the group's pids (zombies included) and each is read (`readDarwin`), its
 * group re-checked in that reading. A pid gone since the listing is skipped; one that cannot be
 * read at all leaves the listing incomplete.
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
  if (now() >= deadlineAt) return { members, complete: false };
  let pids: number[] | null;
  try {
    pids = (deps.groupPids ?? libprocGroupPids)(pgid);
  } catch {
    pids = null;
  }
  if (pids === null) return { members, complete: false };
  let complete = true;
  for (const pid of pids) {
    if (now() >= deadlineAt) return { members, complete: false };
    const r = readDarwin(pid, deps);
    if (r === "gone") continue; // gone since the listing
    if (r === null) {
      complete = false; // a member this reading could not see
      continue;
    }
    if (r.pgid !== pgid || r.zombie) continue; // left the group, or a zombie
    members.push({ pid, identity: r.identity });
  }
  return { members, complete };
}

/** Do two member lists name the same process? Exact on both pid and raw identity. */
export function sameMember(a: GroupMember, b: GroupMember): boolean {
  return a.pid === b.pid && sameIdentity(a.identity, b.identity);
}

/**
 * The numeric start time a raw identity stands for, for the places that compare ages (a leader
 * against the processes born after it) and for records that persist a number. Linux: ticks * 10
 * ms since boot (exact, so equal ticks give equal ms). macOS: the epoch ms of libproc's start time,
 * to the microsecond (`<sec>.<usec>` gives sec * 1000 + usec / 1000). An older daemon's
 * second-precise `lstart` text still projects, to whole-second epoch ms. Null for a null or
 * unparseable identity.
 */
export function startMsFromIdentity(
  identity: string | null,
  platform: string = process.platform,
): number | null {
  if (identity === null || platform === "win32") return null;
  if (platform === "linux") {
    return /^\d+$/.test(identity) ? (Number(identity) * 1000) / LINUX_CLOCK_TICKS_PER_SECOND : null;
  }
  const m = DARWIN_IDENTITY.exec(identity);
  if (m) return Number(m[1]) * 1000 + Number(m[2]) / 1000;
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

/** What comparing a birth identity read now with a recorded one shows. */
export type StartMatch = "same" | "different" | "unknown";

/**
 * Compare an identity read now with a recorded one. `same` only when both were read and are
 * equal; `unknown` when either is missing, or (macOS) when one side is the second-precise `lstart`
 * text of an older daemon and the other is libproc's reading of the same second: a second-precise
 * match never authorises a signal (#596), and it is not proof of another process either.
 * Everything else is `different`.
 */
export function compareIdentity(
  now: string | null,
  recorded: string | null,
  platform: string = process.platform,
): StartMatch {
  if (now === null || recorded === null) return "unknown";
  if (now === recorded) return "same";
  if (platform === "linux" || platform === "win32") return "different";
  const seconds = (identity: string): { sec: number; precise: boolean } | null => {
    const m = DARWIN_IDENTITY.exec(identity);
    if (m) return { sec: Number(m[1]), precise: true };
    const ms = Date.parse(identity);
    return Number.isNaN(ms) ? null : { sec: ms / 1000, precise: false };
  };
  const a = seconds(now);
  const b = seconds(recorded);
  if (a && b && a.precise !== b.precise && a.sec === b.sec) return "unknown";
  return "different";
}

/**
 * Compare a start time read now with a recorded one (`processStartMs`), the numeric form of
 * `compareIdentity`. Exact on every platform: on Linux the next tick is another process, and on
 * macOS a process born a microsecond later is (#570 r14e, H1; #581 cp2). A comparison that
 * authorises a signal must not be given a tolerance. The one `unknown` besides a missing reading
 * is macOS's second-precise record: a whole-second value an older daemon persisted, against a
 * reading in that same second. Linux start times are often whole seconds and are never read so.
 */
export function compareStartMs(
  now: number | null,
  recorded: number | null,
  platform: string = process.platform,
): StartMatch {
  if (now === null || recorded === null) return "unknown";
  if (now === recorded) return "same";
  if (platform === "linux" || platform === "win32") return "different";
  const second = (ms: number): number => Math.floor(ms / 1000) * 1000;
  const wholeSecond = (ms: number): boolean => ms % 1000 === 0;
  if ((wholeSecond(recorded) || wholeSecond(now)) && second(now) === second(recorded))
    return "unknown";
  return "different";
}

/** Do two start times, read by `processStartMs`, belong to one process? Exactly equal (`compareStartMs`). */
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
 * Linux needs this (its start times count from boot; macOS start times are epoch time). A
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

/** A reader that asks the OS once per pid: for one sweep pass, which looks at the same pid several times. */
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
 * the start times cannot tell (`unknown`: a stranger cannot be ruled out, see `compareStartMs`).
 */
export type PidIdentity = "same" | "gone" | "recycled" | "unknown";

export function pidIdentity(
  pid: number,
  expectedStartMs: number | null | undefined,
  { exists, read }: { exists: (pid: number) => boolean; read: StartMsReader },
): PidIdentity {
  if (!exists(pid)) return "gone";
  const match = compareStartMs(read(pid), expectedStartMs ?? null);
  return match === "same" ? "same" : match === "different" ? "recycled" : "unknown";
}
