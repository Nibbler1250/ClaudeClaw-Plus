/**
 * Stop a PTY child and everything it started, and prove it.
 *
 * bun-pty's `kill()` is not a proof of death: it returns at once when it has already run,
 * otherwise it closes the master side, fires `onExit` synchronously with exit code 0 and
 * returns. So an awaited exit event only means "we asked", the SIGKILL escalation after it
 * is a no-op, and a descendant of claude (a git clone, a helper that ignores SIGHUP) is never
 * signalled at all (#570 r12, Codex HIGH).
 *
 * The PTY child is a session leader, so its process group id equals its pid (checked on
 * macOS and Linux, see the r12 section of the #570 report). Signalling `-pid` therefore
 * reaches the whole tree that did not leave the group, and `kill(-pid, 0)` answers whether
 * any of it is left.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import {
  type GroupMember,
  type GroupMembersReader,
  type PidIdentity,
  type PgidReader,
  type PidIdentityReader,
  type StartMsReader,
  pidIdentity,
  processStartMs,
  readGroupMembers,
  readPgid,
  readPidIdentity,
  sameIdentity,
  sameMember,
} from "./pty-proc-identity.js";

export type SignalFn = (pid: number, signal: NodeJS.Signals | 0) => void;

/**
 * Why a retired child is recorded as a survivor, so the call's failure says what happened:
 * its process group was still alive, a process outside the group was, the escape scan could not
 * say, or the disposal itself rejected.
 */
export type SurvivorCause = "group" | "escapee" | "scan-unknown" | "dispose-rejected";

/**
 * What an observation of a group (`groupGoneNow`) needs: no signal is ever sent through it.
 * The signalling algorithm is `retireProcessGroup` below, and there is no other (#581 cp8, H1).
 */
export interface GroupObservationOptions {
  /** `process.kill`. Replaced in tests. */
  signal?: SignalFn;
  /**
   * Live (non-zombie) members of the group; 0 only on positive evidence that every member is a
   * zombie; undefined when this platform cannot say or cannot see every member.
   */
  liveMembers?: (pid: number) => number | undefined;
  /** The leader's start time, recorded at spawn. Null/undefined: it could not be read. */
  leaderStartMs?: number | null;
  /** Reads a pid's start time. Replaced in tests. */
  startMs?: StartMsReader;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A pid that can be signalled as `-pid` without reaching init, our own group or every process. */
export function isSignalablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid;
}

/**
 * Is `-pid` a target this process may ever signal? Only an ISOLATED group: the child was seen to
 * lead a group of its own (`groupId === pid`, read together with its identity at spawn) and that
 * group is not the daemon's (`daemonGroupId`). A child that shares another group is signalled by
 * its pid alone; a group whose id could not be read, or the daemon's own, is never a target
 * (#581 cp8, L1).
 */
export function isolatedGroupTarget(
  pid: number,
  groupId: number | null | undefined,
  daemonGroupId: number | null | undefined,
): boolean {
  return (
    isSignalablePid(pid) &&
    groupId === pid &&
    typeof daemonGroupId === "number" &&
    daemonGroupId > 1 &&
    daemonGroupId !== groupId
  );
}

/** `kill(target, 0)`: ESRCH is the only proof of absence. EPERM means it exists. */
function exists(signal: SignalFn, target: number): boolean {
  try {
    signal(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** `kill(target, 0)` with the three answers told apart: ESRCH absent, EPERM present but not ours to signal. */
function probeSignal(signal: SignalFn, target: number): "absent" | "present" | "eperm" {
  try {
    signal(target, 0);
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "absent";
    return code === "EPERM" ? "eperm" : "present";
  }
}

/** What `GroupTarget.probe` saw. */
interface GroupProbe {
  leaderGone: boolean;
  /** The leader AND every other member of its group. */
  groupGone: boolean;
  /** `kill(-pid, 0)` answered EPERM: members exist that this process may not signal. */
  eperm: boolean;
  /** Live (non-zombie) members; undefined when the platform cannot say. */
  live: number | undefined;
}

/**
 * Linux only: how many members of group `pid` are not zombies, read from `/proc/<n>/stat`
 * (`pid (comm) state ppid pgrp ...`; comm may hold spaces and parens, so split after the last
 * `)`). `kill(pid, 0)` and `kill(-pid, 0)` also succeed for a zombie nobody has reaped yet, which
 * must not read as a survivor. A positive count is returned as soon as a live member is seen.
 * Zero needs positive evidence: at least one member, and every one of them `Z` or `X`. A stat
 * that cannot be read for any reason but its process having gone (a permissions error, say) is a
 * member we could not see, so the answer is then undefined, not zero (#570 r13, D). Undefined
 * off Linux or when `/proc` cannot be read.
 */
export function procLiveMembers(pid: number, procDir = "/proc"): number | undefined {
  if (process.platform !== "linux" && procDir === "/proc") return undefined;
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return undefined;
  }
  let live = 0;
  let zombies = 0;
  let unseen = 0;
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`${procDir}/${name}/stat`, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ESRCH") unseen++; // gone between readdir and read: not unseen
      continue;
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = fields[0];
    const pgrp = Number(fields[2]);
    if (Number(name) !== pid && pgrp !== pid) continue;
    if (state === "Z" || state === "X") zombies++;
    else live++;
  }
  if (live > 0) return live;
  return unseen === 0 && zombies > 0 ? 0 : undefined;
}

/** Both the leader and its group are gone (a zombie that is only waiting to be reaped is gone). */
export function processGroupGone(
  pid: number,
  signal: SignalFn = process.kill,
  liveMembers: (pid: number) => number | undefined = procLiveMembers,
): boolean {
  if (!exists(signal, pid) && !exists(signal, -pid)) return true;
  return liveMembers(pid) === 0;
}

/** What `GroupTarget` is given for one retirement. */
interface GroupTargetDeps {
  /** What the leader is now against the identity recorded at spawn. */
  identityState: () => PidIdentity;
  /** Whether an identity was recorded for the leader at all. */
  identityRecorded: boolean;
  /** An unrecorded identity may be signalled (the initial window only). */
  firstTermination: boolean;
  /** `-pid` is an isolated group target (see `isolatedGroupTarget`). Asked at every signal. */
  isolated: () => boolean;
  /**
   * Fresh evidence that a group answering on this pgid beside an ABSENT leader is ours: a member
   * identified earlier is still in it, with the identity it had. Read now, every time it is asked.
   */
  absentLeaderGroupIsOurs: () => boolean;
  /** No more signals once this says so (the retirement's absolute deadline). */
  expired: () => boolean;
}

/**
 * `kill(2)` with the zero-signal answers made safe against pid reuse. Everything here reads the
 * leader's identity first (#570 r13, B): a pid that now belongs to a process with another birth
 * identity is a stranger, and neither it nor `-pid` is touched (a process group id cannot be
 * reused while the group has a member, so a recycled leader means the group is long gone).
 * The identity is read again immediately before every signal (r14, B). That narrows pid reuse to
 * the instant between the read and the `kill()`; it cannot close it without a native process
 * handle, which is not built here (see pty-proc-identity).
 */
class GroupTarget {
  private loggedUnreadable = false;
  /** A signal was withheld for lack of proof that the group is ours (reported as a reason). */
  withheld = false;
  /** The leader pid was seen to belong to another process: the group is gone, whatever `-pid` says. */
  private recycledSeen = false;

  constructor(
    private readonly pid: number,
    private readonly signal: SignalFn,
    private readonly liveMembers: (pid: number) => number | undefined,
    private readonly deps: GroupTargetDeps,
  ) {}

  identity(): PidIdentity {
    return this.deps.identityState();
  }

  /**
   * One look at the leader and its group, telling the two apart: the leader (pid absent, or a
   * different process now, or every member a zombie) and then every other member of the group.
   * `withIdentity` also re-reads the leader's identity (a `ps` spawn on macOS), which the
   * retirement does on its first and last check only.
   */
  probe(withIdentity: boolean): GroupProbe {
    const leaderExists = exists(this.signal, this.pid);
    if (leaderExists && !this.recycledSeen && withIdentity && this.identity() === "recycled") {
      this.recycledSeen = true;
    }
    // A recycled leader means the group is long gone (a group id cannot be reused while it has a member).
    if (this.recycledSeen) return { leaderGone: true, groupGone: true, eperm: false, live: 0 };
    const group = probeSignal(this.signal, -this.pid);
    if (!leaderExists && group === "absent") {
      return { leaderGone: true, groupGone: true, eperm: false, live: 0 };
    }
    const live = this.liveMembers(this.pid);
    if (live === 0) return { leaderGone: true, groupGone: true, eperm: false, live: 0 };
    return { leaderGone: !leaderExists, groupGone: false, eperm: group === "eperm", live };
  }

  private polls = 0;

  /**
   * Both the leader and its group are gone, or the pid is no longer ours to ask about. The
   * identity is read on the first poll and then every tenth, not every one: it costs a `ps`
   * spawn, and a pid is not reused within 20 ms of being asked about.
   */
  gone(): boolean {
    if (this.polls++ % 10 === 0 && this.identity() === "recycled") return true;
    return processGroupGone(this.pid, this.signal, this.liveMembers);
  }

  /**
   * Signal what is provably ours, the group first. Once the group has been signalled the bare pid
   * is not: the leader is a member of its own group, so a second signal adds nothing and would be
   * one more chance to hit a reused pid. The bare pid is signalled only when the group could not
   * be, and only to a leader whose identity matches.
   */
  send(name: NodeJS.Signals): boolean {
    if (this.deps.expired()) return false; // past the deadline there is no more signalling work
    if (this.sendGroup(name)) return true;
    return this.sendBare(name);
  }

  /** `-pid`, while the group has a member and the leader is not a stranger. True when it was sent. */
  private sendGroup(name: NodeJS.Signals): boolean {
    if (!this.deps.isolated()) return false; // not a group that was proven to be ours alone
    const identity = this.identity(); // read now, not earlier: this is the last look before kill()
    if (identity === "recycled") return false;
    // A start time that was never recorded cannot tell a stranger from the leader. During the
    // first termination of a call the leader was spawned moments ago, and a process group id
    // cannot be reused while the group has a member, so `-pid` is ours while `kill(-pid, 0)`
    // shows one (#570 r14, B). A later retry has no such proof and signals nothing (r14d, H2).
    const unrecordedOk = !this.deps.identityRecorded && this.deps.firstTermination;
    if (identity === "unknown" && unrecordedOk && !this.loggedUnreadable) {
      this.loggedUnreadable = true;
      console.warn(
        `[pty-group-kill] identity of pid ${this.pid} was not recorded; signalling its group on group membership alone`,
      );
    }
    if (!exists(this.signal, -this.pid)) return false;
    // An absent leader leaves the group ours only on fresh member evidence (cp8, H2): a member
    // that was identified earlier is still in it. A saved birth time, a flag, or the time since
    // the last look never says so.
    const known =
      identity === "same" ||
      (identity === "gone" && this.deps.absentLeaderGroupIsOurs()) ||
      (identity === "unknown" && unrecordedOk);
    if (!known) {
      this.withheld = true;
      return false;
    }
    try {
      this.signal(-this.pid, name);
      this.withheld = false;
      return true;
    } catch {
      return false; // ESRCH: nothing there to signal
    }
  }

  private sendBare(name: NodeJS.Signals): boolean {
    const identity = this.identity();
    // Only a leader whose identity matches, or an unrecorded one in the initial window.
    const unrecordedOk = !this.deps.identityRecorded && this.deps.firstTermination;
    if (identity !== "same" && !(identity === "unknown" && unrecordedOk)) return false;
    try {
      this.signal(this.pid, name);
      return true;
    } catch {
      return false; /* ESRCH: nothing there to signal */
    }
  }
}

/**
 * Whether the group of `pid` (and its leader) is gone right now, by the same rules as the
 * retirement: a recycled leader means the group is long gone, a group made only of zombies is
 * gone. For a caller that has to decide on a recorded survivor without signalling it (the sweep).
 */
export function groupGoneNow(pid: number, opts: GroupObservationOptions = {}): boolean {
  const { signal = process.kill, liveMembers = procLiveMembers } = opts;
  if (!isSignalablePid(pid)) return false; // not a pid to reason about: not proof of absence
  const read = opts.startMs ?? processStartMs;
  return new GroupTarget(pid, signal, liveMembers, {
    identityState: () =>
      pidIdentity(pid, opts.leaderStartMs ?? null, { exists: (p) => exists(signal, p), read }),
    identityRecorded: (opts.leaderStartMs ?? null) !== null,
    firstTermination: false,
    isolated: () => false,
    absentLeaderGroupIsOurs: () => false,
    expired: () => false,
  }).gone();
}

// ─── The common retirement (#581 cp3) ───────────────────────────────────────

/**
 * Why a group is not confirmed gone while its leader is:
 *   survivor          a member is still alive after SIGKILL
 *   eperm             `kill(-pid, 0)` answered EPERM: there are members this process may not signal
 *   unreadable        members remain and the platform cannot say whether any is a live one
 *   unknown-identity  a signal was withheld: nothing proved the group is ours
 */
export type GroupReason = "survivor" | "eperm" | "unreadable" | "unknown-identity";

/** Who is left in a group, as names only: an executable basename per member, never an argv. */
export interface GroupDescription {
  count: number | undefined;
  comm: string[];
}

export interface RetireGroupInput {
  pid: number;
  /** Raw birth identity captured at spawn; null when it could not be read. */
  identity: string | null;
  /**
   * The leader's process group id as last read while the leader was the recorded process (see
   * `RetireGroupOutcome.groupId`); null when it never was. It is read again at the start of
   * every call that finds the leader still there, and the fresh reading wins: a reading taken
   * the instant after the fork can predate the child's `setsid()`. Negative targets are used
   * only when it equals `pid` and differs from `daemonGroupId` (`isolatedGroupTarget`).
   */
  groupId: number | null;
  /**
   * The daemon's own process group id; null when it cannot be read. Omitted: read now through
   * `readGroupId`, inside the deadline.
   */
  daemonGroupId?: number | null;
  /**
   * Members of the group identified positively (pid and birth identity) by an earlier
   * retirement. They are evidence, never authority: each is read again before it counts.
   */
  members: readonly GroupMember[];
  /** Lists a group's members with their identities. Replaced in tests: a fake never reaches a real pid. */
  readMembers?: GroupMembersReader;
  /** Reads the leader's process group id. Replaced in tests. */
  readGroupId?: PgidReader;
  /**
   * Reads a pid's birth identity now. Replaced in tests. The default is bounded by what is left
   * of `deadlineAt`, so a `ps` it starts cannot outlast the retirement.
   */
  readIdentity?: PidIdentityReader;
  /** `process.kill`. Replaced in tests: a fake never reaches a real pid. */
  signal?: SignalFn;
  /** Live members of the group; see `GroupObservationOptions.liveMembers`. */
  liveMembers?: (pid: number) => number | undefined;
  /** Names the members left, for the report only. Replaced in tests. */
  describe?: (pid: number, deadlineAt: number) => GroupDescription;
  /** The first retirement of this process. A delayed confirmation has no such privilege. */
  initial: boolean;
  /** Whether an unrecorded identity may be signalled in the initial window (false: never). */
  allowUnrecordedInitial: boolean;
  /** SIGTERM the group first (the initial retirement). */
  sendTerm: boolean;
  /**
   * ONE absolute wall-clock deadline for the whole retirement, scans included. Past it nothing
   * is signalled, listed or described; what is unresolved stays unresolved.
   */
  deadlineAt: number;
  /** How long SIGTERM gets before SIGKILL, counted from the call and never past `deadlineAt`. */
  termGraceMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RetireGroupOutcome {
  /** The leader pid is absent, or is another process now, or every member is a zombie. */
  leaderGone: boolean;
  /** The leader AND every other member of its group. */
  groupGone: boolean;
  /** Set exactly when the leader is gone and the group is not. */
  reason: GroupReason | null;
  /** Members left, when it could be counted. */
  survivors: number | undefined;
  /** Executable basenames of the members left. */
  comm: string[];
  /**
   * The leader's process group id as read in this call while the leader was the recorded
   * process, else what the call was given. Carried to the next call like `members`.
   */
  groupId: number | null;
  /**
   * The group members positively identified as of this call: what a later confirmation, or a
   * sweeper retry, carries into `RetireGroupInput.members`. Empty when the group is gone or
   * when nothing vouched for it. The carrier re-reads each before it grants any authority.
   */
  members: GroupMember[];
}

/** How often a SIGTERM that could not be sent yet is tried again, inside the TERM grace. */
const TERM_RETRY_MS = 100;

/**
 * The report (who is left, and which members to carry on) is taken this long before the
 * deadline, while time remains: after the deadline nothing is listed or described.
 */
const REPORT_MARGIN_MS = 250;

/**
 * Group members by name, for the report: Linux from `/proc`, elsewhere one `ps` bounded by what
 * is left of `deadlineAt` (none left: not counted, no subprocess).
 */
export function describeGroup(
  pid: number,
  deadlineAt: number = Number.POSITIVE_INFINITY,
  procDir = "/proc",
): GroupDescription {
  const names = new Set<string>();
  let count = 0;
  try {
    if (process.platform === "linux" || procDir !== "/proc") {
      for (const entry of readdirSync(procDir)) {
        if (!/^\d+$/.test(entry)) continue;
        let stat: string;
        try {
          stat = readFileSync(`${procDir}/${entry}/stat`, "utf8");
        } catch {
          continue;
        }
        const open = stat.indexOf("(");
        const close = stat.lastIndexOf(")");
        const fields = stat.slice(close + 2).split(" ");
        if (Number(fields[2]) !== pid && Number(entry) !== pid) continue;
        if (fields[0] === "Z" || fields[0] === "X") continue;
        count++;
        names.add(stat.slice(open + 1, close));
      }
    } else {
      const left = deadlineAt - Date.now();
      if (!(left > 0)) return { count: undefined, comm: [] };
      const r = spawnSync("ps", ["-axo", "pgid=,stat=,comm="], {
        encoding: "utf8",
        timeout: Math.min(2000, left),
      });
      if (r.status !== 0) return { count: undefined, comm: [] };
      for (const line of (r.stdout ?? "").split("\n")) {
        const m = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
        if (!m || Number(m[1]) !== pid || m[2]?.startsWith("Z")) continue;
        count++;
        names.add(m[3] ?? "");
      }
    }
  } catch {
    return { count: undefined, comm: [] };
  }
  return { count, comm: [...names].map((n) => basename(n)).filter(Boolean) };
}

/** The leader's state against the identity recorded at spawn. Exact: nothing widens "the same process". */
function rawIdentityState(
  pid: number,
  recorded: string | null,
  signal: SignalFn,
  read: PidIdentityReader,
): PidIdentity {
  if (!exists(signal, pid)) return "gone";
  const now = read(pid);
  if (recorded === null || now === null) return "unknown";
  return sameIdentity(now, recorded) ? "same" : "recycled";
}

/** Add the members of `fresh` that are not in `into` yet. */
function mergeMembers(into: readonly GroupMember[], fresh: readonly GroupMember[]): GroupMember[] {
  const out = [...into];
  for (const m of fresh) if (!out.some((x) => sameMember(x, m))) out.push(m);
  return out;
}

export interface NoteMembersInput {
  pid: number;
  identity: string | null;
  groupId: number | null;
  /** Members remembered so far; the result adds to them. */
  members: readonly GroupMember[];
  signal?: SignalFn;
  readIdentity?: PidIdentityReader;
  readMembers?: GroupMembersReader;
  readGroupId?: PgidReader;
  /** The daemon's own group id; omitted: read now. */
  daemonGroupId?: number | null;
  /** How long this look may take (default 1000 ms). */
  budgetMs?: number;
  /**
   * Whether a leader that is already absent still counts as proof the group is ours. Only at the
   * instant its exit is first seen (the exit callback): a group listed at any later time may be a
   * stranger's, so every other caller passes false and learns members only from a live leader.
   */
  leaderJustExited?: boolean;
}

/**
 * Remember who is in a child's process group while that group is provably ours, so that a later
 * retirement has evidence once the leader is gone (#581 cp8, H2). Called before anything is
 * signalled and when the leader's exit is first seen. A group is taken as ours only when the
 * leader is the recorded process (`same`) or, only at the instant its exit is first seen
 * (`leaderJustExited`: while a group has a member its id cannot be reused, so whoever is in it
 * at the moment its leader goes is ours), is absent. Never when the pid belongs to another
 * process or cannot be read, and never for an absent leader at any later time. It needs an isolated group
 * (`isolatedGroupTarget`). Nothing is signalled. A listing that fails changes nothing.
 */
export function noteGroupMembers(input: NoteMembersInput): {
  members: GroupMember[];
  groupId: number | null;
} {
  const unchanged = { members: [...input.members], groupId: input.groupId };
  const { pid, identity } = input;
  if (process.platform === "win32" || !isSignalablePid(pid) || identity === null) return unchanged;
  const deadlineAt = Date.now() + (input.budgetMs ?? 1000);
  const signal = input.signal ?? process.kill;
  const readIdentity: PidIdentityReader = input.readIdentity ?? ((p) => readPidIdentity(p));
  const readGroupId: PgidReader = input.readGroupId ?? ((p) => readPgid(p));
  const state = rawIdentityState(pid, identity, signal, readIdentity);
  if (state === "recycled" || state === "unknown") return unchanged;
  if (state === "gone" && input.leaderJustExited !== true) return unchanged;
  let groupId = input.groupId;
  if (state === "same") {
    const fresh = readGroupId(pid);
    if (fresh !== null) groupId = fresh;
  }
  const daemon = input.daemonGroupId !== undefined ? input.daemonGroupId : readGroupId(process.pid);
  if (!isolatedGroupTarget(pid, groupId, daemon)) return { members: unchanged.members, groupId };
  try {
    const reading = (input.readMembers ?? ((g, at) => readGroupMembers(g, at)))(pid, deadlineAt);
    return { members: mergeMembers(input.members, reading.members), groupId };
  } catch {
    return { members: unchanged.members, groupId };
  }
}

/**
 * THE termination and confirmation of a PTY child and its process group, and the only one:
 * SIGTERM the group, wait for the leader AND every other member to be gone, SIGKILL after
 * `termGraceMs`, wait again, all inside one absolute `deadlineAt` that the caller owns. It holds
 * no config root, slot, quarantine or turn state: it reports what the OS shows
 * (`RetireGroupOutcome`), and the caller decides what that means (`PtyProcess` retirement, the
 * bus adapter, the schema probe, the sweeper's survivor retry).
 *
 * Signal authority (plan "Signal authority", cp8 H1/H2/L1):
 *  - the leader's identity is read again immediately before every signal, and a recycled leader
 *    is never signalled;
 *  - `-pid` is a target only for an isolated group (`isolatedGroupTarget`);
 *  - while the leader is the process we recorded the group is ours. Once the leader is absent
 *    it is ours only if a member identified EARLIER (pid and birth identity, from the initial
 *    retirement or a previous call) is read again now, in that group, with the same identity.
 *    No flag and no elapsed time grants that;
 *  - without such evidence nothing is sent and the outcome says `unknown-identity`.
 * ESRCH proves absence; EPERM and an unreadable enumeration do not. An exit event never
 * proves death. Past `deadlineAt` nothing is signalled, listed, described or spawned.
 */
export async function retireProcessGroup(input: RetireGroupInput): Promise<RetireGroupOutcome> {
  const {
    pid,
    identity,
    signal = process.kill,
    liveMembers = procLiveMembers,
    pollMs = 20,
    now = Date.now,
    sleep = defaultSleep,
  } = input;
  const left = (): number => input.deadlineAt - now();
  const readIdentity: PidIdentityReader =
    input.readIdentity ?? ((p) => readPidIdentity(p, { psTimeoutMs: Math.max(0, left()) }));
  const readMembers: GroupMembersReader =
    input.readMembers ?? ((pgid, deadlineAt) => readGroupMembers(pgid, deadlineAt, { now }));
  const readGroupId: PgidReader =
    input.readGroupId ?? ((p) => readPgid(p, { psTimeoutMs: Math.max(0, left()) }));
  const describe = input.describe ?? ((p, at) => describeGroup(p, at));
  const unknown: RetireGroupOutcome = {
    leaderGone: false,
    groupGone: false,
    reason: null,
    survivors: undefined,
    comm: [],
    groupId: input.groupId,
    members: [],
  };
  if (!isSignalablePid(pid)) return unknown;
  let groupId = input.groupId;
  const daemonGroupId =
    input.daemonGroupId !== undefined ? input.daemonGroupId : readGroupId(process.pid);
  const isolated = (): boolean => isolatedGroupTarget(pid, groupId, daemonGroupId);

  // Members identified so far: evidence only, merged from every positive reading.
  let known: GroupMember[] = [...input.members];
  const read = (): { members: GroupMember[]; complete: boolean } | null => {
    if (!isolated() || left() <= 0) return null; // no group to list, or no time to list it
    return readMembers(pid, input.deadlineAt);
  };
  const list = (): GroupMember[] | null => read()?.members ?? null;
  const target = new GroupTarget(pid, signal, liveMembers, {
    identityState: () => rawIdentityState(pid, identity, signal, readIdentity),
    identityRecorded: identity !== null,
    firstTermination: input.initial && input.allowUnrecordedInitial,
    isolated,
    expired: () => left() <= 0,
    absentLeaderGroupIsOurs: () => {
      // Fresh evidence only, asked at the moment a signal would be sent: is a member identified
      // earlier still in the group, with the identity it had?
      const fresh = list();
      if (fresh === null || !fresh.some((f) => known.some((k) => sameMember(k, f)))) return false;
      known = mergeMembers(
        known.filter((k) => fresh.some((f) => sameMember(k, f))),
        fresh,
      );
      return true;
    },
  });

  // While the leader is the process we recorded its group is ours: remember who is in it, so a
  // later retirement can still prove the group is the same one after the leader is gone.
  if (target.identity() === "same") {
    // The leader is the recorded process, so what its group id is NOW is its group id for good (a
    // session leader cannot move itself out of its group). The reading at spawn can predate setsid().
    const fresh = readGroupId(pid);
    if (fresh !== null) groupId = fresh;
    const members = list();
    if (members !== null) known = mergeMembers(known, members);
  }

  const look = (withIdentity: boolean): GroupProbe => target.probe(withIdentity);
  // Identity is read on the first and the last check of a wait only (a `ps` spawn on macOS).
  // A SIGTERM that could not be sent yet is tried again every TERM_RETRY_MS inside the grace: a
  // leader that is dying can read as "identity unknown" for a moment, and waiting out the whole
  // grace for a signal that was merely early would turn a prompt exit into a SIGKILL.
  let termPending = input.sendTerm;
  let lastTry = now();
  // Taken once, near the end of the final wait, only if the group is still there by then.
  let report: {
    described: GroupDescription;
    fresh: { members: GroupMember[]; complete: boolean } | null;
  } | null = null;
  const takeReport = (): void => {
    if (report !== null || left() <= 0) return;
    report = { described: describe(pid, input.deadlineAt), fresh: read() };
  };
  const waitGone = async (untilMs: number, final = false): Promise<GroupProbe> => {
    let probe = look(true);
    for (;;) {
      if (probe.groupGone) return probe;
      const remaining = Math.min(untilMs, input.deadlineAt) - now();
      if (final && remaining <= REPORT_MARGIN_MS && probe.leaderGone) takeReport();
      if (remaining <= 0) return probe;
      await sleep(Math.min(pollMs, remaining));
      if (termPending && now() - lastTry >= TERM_RETRY_MS) {
        lastTry = now();
        termPending = !target.send("SIGTERM");
      }
      probe = look(now() >= untilMs);
    }
  };

  if (termPending) termPending = !target.send("SIGTERM");
  let probe = await waitGone(Math.min(input.deadlineAt, now() + input.termGraceMs));
  if (!probe.groupGone) {
    target.send("SIGKILL");
    probe = await waitGone(input.deadlineAt, true);
  }
  if (probe.groupGone) {
    return { ...unknown, leaderGone: true, groupGone: true, survivors: 0, groupId };
  }
  if (!probe.leaderGone) {
    return { ...unknown, leaderGone: false, survivors: probe.live, groupId, members: known };
  }
  // Leader gone, group not: record who is left, but only what was read in a group that is ours.
  // Leader gone, group not: carry on what was positively identified. A fresh listing that shows
  // none of the members known is a group nothing vouches for; with no listing (no time left)
  // the members known stay as the evidence they are, to be read again when they are used.
  takeReport(); // a no-op once taken, and when no time remains
  const taken = report as {
    described: GroupDescription;
    fresh: { members: GroupMember[]; complete: boolean } | null;
  } | null;
  let carried: GroupMember[] = known;
  if (taken?.fresh) {
    const { members: fresh, complete } = taken.fresh;
    // A complete listing that shows none of the members known is positive absence: nothing
    // vouches for what is there. An incomplete one cannot say, so the evidence is kept.
    if (fresh.some((f) => known.some((k) => sameMember(k, f)))) carried = fresh;
    else if (complete) carried = [];
  }
  const described = taken?.described ?? { count: undefined, comm: [] };
  const reason: GroupReason = probe.eperm
    ? "eperm"
    : target.withheld
      ? "unknown-identity"
      : probe.live !== undefined && probe.live > 0
        ? "survivor"
        : "unreadable";
  return {
    leaderGone: true,
    groupGone: false,
    reason,
    survivors: described.count ?? probe.live,
    comm: described.comm,
    groupId,
    members: carried,
  };
}
