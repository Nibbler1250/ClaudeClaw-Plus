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
  type PidIdentity,
  type PidIdentityReader,
  type StartMsReader,
  pidIdentity,
  processStartMs,
  readPidIdentity,
  sameIdentity,
} from "./pty-proc-identity.js";

export type SignalFn = (pid: number, signal: NodeJS.Signals | 0) => void;

/**
 * Why a retired child is recorded as a survivor, so the call's failure says what happened:
 * its process group was still alive, a process outside the group was, the escape scan could not
 * say, or the disposal itself rejected.
 */
export type SurvivorCause = "group" | "escapee" | "scan-unknown" | "dispose-rejected";

export interface GroupTerminationOptions {
  /** `process.kill`. Replaced in tests. */
  signal?: SignalFn;
  sleep?: (ms: number) => Promise<void>;
  /** How long after SIGTERM the group may take to disappear before SIGKILL. */
  termGraceMs?: number;
  /** How long after SIGKILL the group may take to disappear before the call fails. */
  killGraceMs?: number;
  pollMs?: number;
  /**
   * Live (non-zombie) members of the group; 0 only on positive evidence that every member is a
   * zombie; undefined when this platform cannot say or cannot see every member.
   */
  liveMembers?: (pid: number) => number | undefined;
  /** The leader's start time, recorded at spawn. Null/undefined: it could not be read. */
  leaderStartMs?: number | null;
  /** Reads a pid's start time. Replaced in tests. */
  startMs?: StartMsReader;
  /**
   * Whether the PTY still owns the leader (it has not exited and been reaped), so its pid cannot
   * have been reused. Default false: once the child is gone only `-pid` is signalled, and only
   * while the group still has a member.
   */
  leaderAlive?: () => boolean;
  /**
   * This is the first termination of a call, run while the call disposes its own PTY: the leader
   * was spawned moments ago, so a group that has a member is ours even when no start time could
   * be recorded for it. Only then may `-pid` be signalled for an unrecorded start time. A retry
   * of a survivor minutes later, or the sweeper, leaves it unset: by then group membership no
   * longer proves the group is ours, and nothing is signalled without a recorded start time
   * (#570 r14d, H2). Passed by the caller; never inferred from timing here.
   */
  firstTermination?: boolean;
  /**
   * #581 cp3, the common retirement (`retireProcessGroup`): what the leader is now, judged
   * against the raw identity recorded at spawn, in place of the numeric start-time comparison.
   */
  identityState?: () => PidIdentity;
  /**
   * Whether an identity was recorded for the leader at all (default: `leaderStartMs` is set).
   * Only with `retire` below.
   */
  identityRecorded?: boolean;
  /**
   * Switches the signal authority to the retirement rules (#581 cp3, plan "Signal authority"):
   *  - a leader that is absent leaves the group ours only when `absentLeaderGroupIsOurs`: the
   *    retirement began while the leader was alive or just exited, or the group was seen alive
   *    with it. A saved start time alone never says so;
   *  - an unreadable identity authorises a signal only for an unrecorded one, in the initial
   *    window (`firstTermination`), and never because the PTY "still owns" the pid;
   *  - the bare leader pid is signalled only when its identity matches.
   */
  retire?: { absentLeaderGroupIsOurs: () => boolean };
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A pid that can be signalled as `-pid` without reaching init, our own group or every process. */
export function isSignalablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid;
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

/**
 * `kill(2)` with the zero-signal answers made safe against pid reuse. Everything here reads the
 * leader's identity first (#570 r13, B): a pid that now belongs to a process with another start
 * time is a stranger, and neither it nor `-pid` is touched (a process group id cannot be
 * reused while the group has a member, so a recycled leader means the group is long gone).
 * The identity is read again immediately before every signal (r14, B). That narrows pid reuse to
 * the instant between the read and the `kill()`; it cannot close it without a native process
 * handle, which is not built here (see pty-proc-identity).
 */
class GroupTarget {
  private readonly leaderStartMs: number | null;
  private readonly read: StartMsReader;
  private readonly owned: () => boolean;
  private readonly firstTermination: boolean;
  private readonly recorded: boolean;
  private readonly retire: GroupTerminationOptions["retire"];
  private readonly identityState: GroupTerminationOptions["identityState"];
  private loggedUnreadable = false;
  /** A signal was withheld for lack of proof that the group is ours (reported as a reason). */
  withheld = false;
  /** The leader pid was seen to belong to another process: the group is gone, whatever `-pid` says. */
  private recycledSeen = false;

  constructor(
    private readonly pid: number,
    private readonly signal: SignalFn,
    private readonly liveMembers: (pid: number) => number | undefined,
    opts: GroupTerminationOptions,
  ) {
    this.leaderStartMs = opts.leaderStartMs ?? null;
    this.read = opts.startMs ?? processStartMs;
    this.owned = opts.leaderAlive ?? (() => false);
    this.firstTermination = opts.firstTermination === true;
    this.retire = opts.retire;
    this.identityState = opts.identityState;
    this.recorded = opts.identityRecorded ?? this.leaderStartMs !== null;
  }

  identity(): PidIdentity {
    if (this.identityState) return this.identityState();
    return pidIdentity(this.pid, this.leaderStartMs, {
      exists: (p) => exists(this.signal, p),
      read: this.read,
    });
  }

  /**
   * One look at the leader and its group, by the same rules as `gone()` but telling the two
   * apart: the leader (pid absent, or a different process now, or every member a zombie) and then
   * every other member of the group. `withIdentity` also re-reads the leader's identity (a `ps`
   * spawn on macOS), which the retirement does on its first and last check only.
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
   * Both the leader and its group are gone, or the pid is no longer ours to ask about. The start
   * time is read on the first poll and then every tenth, not every one: it costs a `ps` spawn,
   * and a pid is not reused within 20 ms of being asked about.
   */
  gone(): boolean {
    if (this.polls++ % 10 === 0 && this.identity() === "recycled") return true;
    return processGroupGone(this.pid, this.signal, this.liveMembers);
  }

  /**
   * Signal what is provably ours, the group first. Once the group has been signalled the bare pid
   * is not: the leader is a member of its own group, so a second signal adds nothing and would be
   * one more chance to hit a reused pid. The bare pid is signalled only when the group could not
   * be (a leader that moved itself out of its group), while the PTY still owns it.
   */
  send(name: NodeJS.Signals): boolean {
    if (this.sendGroup(name)) return true;
    return this.sendBare(name);
  }

  /** `-pid`, while the group has a member and the leader is not a stranger. True when it was sent. */
  private sendGroup(name: NodeJS.Signals): boolean {
    const identity = this.identity(); // read now, not earlier: this is the last look before kill()
    if (identity === "recycled") return false;
    // A start time that was never recorded cannot tell a stranger from the leader. During the
    // first termination of a call the leader was spawned moments ago, and a process group id
    // cannot be reused while the group has a member, so `-pid` is ours while `kill(-pid, 0)`
    // shows one (#570 r14, B). A later retry has no such proof and signals nothing (r14d, H2).
    const unrecordedOk = !this.recorded && this.firstTermination;
    if (identity === "unknown" && unrecordedOk && !this.loggedUnreadable) {
      this.loggedUnreadable = true;
      console.warn(
        `[pty-group-kill] start time of pid ${this.pid} was not recorded; signalling its group on group membership alone`,
      );
    }
    // `gone` is read before the recorded start time is looked at, so it says only that the leader
    // pid is absent. A live `-pid` group beside an absent leader is ours only if we recorded the
    // leader, or this is the first termination (r14e, H2). The retirement narrows that further:
    // a saved start time alone proves nothing about a group whose leader is gone (#581 cp3).
    const absentOk = this.retire
      ? this.retire.absentLeaderGroupIsOurs()
      : this.recorded || unrecordedOk;
    const unknownOk = this.retire ? unrecordedOk : this.owned() || unrecordedOk;
    const known =
      identity === "same" ||
      (identity === "gone" && absentOk) ||
      (identity === "unknown" && unknownOk);
    if (!exists(this.signal, -this.pid)) return false;
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
    if (this.retire) {
      // The retirement: only a leader whose identity matches, or an unrecorded one in the initial window.
      const unrecordedOk = !this.recorded && this.firstTermination;
      if (identity !== "same" && !(identity === "unknown" && unrecordedOk)) return false;
    } else if (!this.owned() || (identity !== "same" && identity !== "unknown")) return false;
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
 * termination: a recycled leader means the group is long gone, a group made only of zombies is
 * gone. For a caller that has to decide on a recorded survivor without signalling it (the sweep).
 */
export function groupGoneNow(pid: number, opts: GroupTerminationOptions = {}): boolean {
  const { signal = process.kill, liveMembers = procLiveMembers } = opts;
  if (!isSignalablePid(pid)) return false; // not a pid to reason about: not proof of absence
  return new GroupTarget(pid, signal, liveMembers, opts).gone();
}

/**
 * SIGTERM the group, wait for the leader and the group to disappear, escalate to SIGKILL after
 * `termGraceMs`, wait again for up to `killGraceMs`. Resolves true only when both `kill(pid, 0)`
 * and `kill(-pid, 0)` have answered ESRCH (or the pid was reused, so the group is gone). Resolves
 * false when something outlived SIGKILL, or when the pid is not one that may be signalled.
 * Before every signal, the escalation included, the leader's start time is checked against
 * `leaderStartMs`, so a pid that was reaped and reused in the meantime is never signalled.
 */
export async function terminateProcessGroup(
  pid: number,
  opts: GroupTerminationOptions = {},
): Promise<boolean> {
  const {
    signal = process.kill,
    sleep = defaultSleep,
    termGraceMs = 2000,
    killGraceMs = 2000,
    pollMs = 20,
    liveMembers = procLiveMembers,
  } = opts;
  if (!isSignalablePid(pid)) return false;
  const target = new GroupTarget(pid, signal, liveMembers, opts);

  const waitGone = async (budgetMs: number): Promise<boolean> => {
    for (let waited = 0; ; waited += pollMs) {
      if (target.gone()) return true;
      if (waited >= budgetMs) return false;
      await sleep(pollMs);
    }
  };

  target.send("SIGTERM");
  if (await waitGone(termGraceMs)) return true;
  target.send("SIGKILL");
  return waitGone(killGraceMs);
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
  /** Reads a pid's birth identity now. Replaced in tests. */
  readIdentity?: PidIdentityReader;
  /** `process.kill`. Replaced in tests: a fake never reaches a real pid. */
  signal?: SignalFn;
  /** Live members of the group; see `GroupTerminationOptions.liveMembers`. */
  liveMembers?: (pid: number) => number | undefined;
  /** Names the members left, for the report only. Replaced in tests. */
  describe?: (pid: number) => GroupDescription;
  /** The first retirement of this process. A delayed confirmation has no such privilege. */
  initial: boolean;
  /** The leader was alive when this retirement began (not an exit that happened earlier). */
  leaderSeenAlive: boolean;
  /**
   * The group was seen alive together with its leader or when the leader went (or an earlier
   * retirement found survivors), so an absent leader does not make `-pid` a stranger's.
   */
  groupContinuity: boolean;
  /** Whether an unrecorded identity may be signalled in the initial window (false: never). */
  allowUnrecordedInitial: boolean;
  /** SIGTERM the group first (the initial retirement). */
  sendTerm: boolean;
  /** ONE absolute wall-clock deadline for the whole retirement, scans included. */
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
   * The continuity a later confirmation may rely on, as this call left it: true only when the
   * call began holding valid evidence (or the leader was alive at its start) and no probe has
   * found the group absent since. Never set because a group was merely SEEN: a group seen while
   * a signal was withheld is exactly one nothing vouched for (security review of cp3).
   */
  continuityHeld: boolean;
}

/** How often a SIGTERM that could not be sent yet is tried again, inside the TERM grace. */
const TERM_RETRY_MS = 100;

/** Group members by name, for the report: Linux from `/proc`, elsewhere one bounded `ps`. */
export function describeGroup(pid: number, procDir = "/proc"): GroupDescription {
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
      const r = spawnSync("ps", ["-axo", "pgid=,stat=,comm="], { encoding: "utf8", timeout: 2000 });
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

/**
 * THE termination and confirmation of a PTY child and its process group: SIGTERM the group,
 * wait for the leader AND every other member to be gone, SIGKILL after `termGraceMs`, wait again,
 * all inside one absolute `deadlineAt` that the caller owns. It holds no config root, slot,
 * quarantine or turn state: it reports what the OS shows (`RetireGroupOutcome`), and the caller
 * decides what that means (`PtyProcess` retirement, the bus adapter, the schema probe).
 *
 * Signal authority: the leader's identity is read again immediately before every signal, and a
 * recycled leader is never signalled. Only a group that is provably ours is signalled with
 * `-pid` (see `GroupTerminationOptions.retire`); when it cannot be proved, nothing is sent and
 * the outcome says `unknown-identity`. ESRCH proves absence; EPERM and an unreadable
 * enumeration do not. Never infers death from an exit event.
 */
export async function retireProcessGroup(input: RetireGroupInput): Promise<RetireGroupOutcome> {
  const {
    pid,
    identity,
    readIdentity = readPidIdentity,
    signal = process.kill,
    liveMembers = procLiveMembers,
    describe = (p) => describeGroup(p),
    pollMs = 20,
    now = Date.now,
    sleep = defaultSleep,
  } = input;
  const unknown: RetireGroupOutcome = {
    leaderGone: false,
    groupGone: false,
    reason: null,
    survivors: undefined,
    comm: [],
    continuityHeld: false,
  };
  if (!isSignalablePid(pid)) return unknown;
  const target = new GroupTarget(pid, signal, liveMembers, {
    identityState: () => rawIdentityState(pid, identity, signal, readIdentity),
    identityRecorded: identity !== null,
    firstTermination: input.initial && input.allowUnrecordedInitial,
    retire: { absentLeaderGroupIsOurs: () => continuity },
  });

  // Evidence that a group answering on this pgid, beside an absent leader, is ours. It is fresh
  // evidence only: the moment any probe finds the group ABSENT it is revoked, because a group
  // that is seen again after that is not the one that was seen before (a stranger's, on a
  // recycled pid). Security review of cp3.
  let continuity = input.groupContinuity || (input.initial && input.leaderSeenAlive);
  const look = (withIdentity: boolean): GroupProbe => {
    const probe = target.probe(withIdentity);
    if (probe.groupGone) continuity = false; // nothing is left that evidence could vouch for
    return probe;
  };
  // Identity is read on the first and the last check of a wait only (a `ps` spawn on macOS).
  // A SIGTERM that could not be sent yet is tried again every TERM_RETRY_MS inside the grace: a
  // leader that is dying can read as "identity unknown" for a moment, and waiting out the whole
  // grace for a signal that was merely early would turn a prompt exit into a SIGKILL.
  let termPending = input.sendTerm;
  let lastTry = now();
  const waitGone = async (untilMs: number): Promise<GroupProbe> => {
    let probe = look(true);
    for (;;) {
      if (probe.groupGone) return probe;
      const left = untilMs - now();
      if (left <= 0) return probe;
      await sleep(Math.min(pollMs, left));
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
    probe = await waitGone(input.deadlineAt);
  }
  if (probe.groupGone) {
    return { ...unknown, leaderGone: true, groupGone: true, survivors: 0, continuityHeld: false };
  }
  if (!probe.leaderGone) {
    return { ...unknown, leaderGone: false, survivors: probe.live, continuityHeld: continuity };
  }
  const described = describe(pid);
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
    continuityHeld: continuity,
  };
}
