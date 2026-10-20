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

import { readFileSync, readdirSync } from "node:fs";

export type SignalFn = (pid: number, signal: NodeJS.Signals | 0) => void;

export interface GroupTerminationOptions {
  /** `process.kill`. Replaced in tests. */
  signal?: SignalFn;
  sleep?: (ms: number) => Promise<void>;
  /** How long after SIGTERM the group may take to disappear before SIGKILL. */
  termGraceMs?: number;
  /** How long after SIGKILL the group may take to disappear before the call fails. */
  killGraceMs?: number;
  pollMs?: number;
  /** Live (non-zombie) members of the group, or undefined when this platform cannot say. */
  liveMembers?: (pid: number) => number | undefined;
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

/**
 * Linux only: how many members of group `pid` are not zombies, read from `/proc/<n>/stat`
 * (`pid (comm) state ppid pgrp ...`; comm may hold spaces and parens, so split after the last
 * `)`). `kill(pid, 0)` and `kill(-pid, 0)` also succeed for a zombie nobody has reaped yet, which
 * must not read as a survivor. Undefined off Linux or when `/proc` cannot be read.
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
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`${procDir}/${name}/stat`, "utf8");
    } catch {
      continue; // gone between readdir and read
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const state = fields[0];
    const pgrp = Number(fields[2]);
    if ((Number(name) === pid || pgrp === pid) && state !== "Z" && state !== "X") live++;
  }
  return live;
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

function send(signal: SignalFn, pid: number, name: NodeJS.Signals): void {
  // The group first; the leader too, so a child that is not its own group leader still gets it.
  for (const target of [-pid, pid]) {
    try {
      signal(target, name);
    } catch {
      /* ESRCH: nothing there to signal */
    }
  }
}

/**
 * SIGTERM the group, wait for the leader and the group to disappear, escalate to SIGKILL after
 * `termGraceMs`, wait again for up to `killGraceMs`. Resolves true only when both `kill(pid, 0)`
 * and `kill(-pid, 0)` have answered ESRCH. Resolves false when something outlived SIGKILL, or
 * when the pid is not one that may be signalled.
 */
export async function terminateProcessGroup(
  pid: number,
  {
    signal = process.kill,
    sleep = defaultSleep,
    termGraceMs = 2000,
    killGraceMs = 2000,
    pollMs = 20,
    liveMembers = procLiveMembers,
  }: GroupTerminationOptions = {},
): Promise<boolean> {
  if (!isSignalablePid(pid)) return false;

  const waitGone = async (budgetMs: number): Promise<boolean> => {
    for (let waited = 0; ; waited += pollMs) {
      if (processGroupGone(pid, signal, liveMembers)) return true;
      if (waited >= budgetMs) return false;
      await sleep(pollMs);
    }
  };

  send(signal, pid, "SIGTERM");
  if (await waitGone(termGraceMs)) return true;
  send(signal, pid, "SIGKILL");
  return waitGone(killGraceMs);
}
