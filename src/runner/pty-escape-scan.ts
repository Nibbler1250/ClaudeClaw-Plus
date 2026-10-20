/**
 * Descendants of an untrusted claude that left its process group (a `setsid()` or `setpgid()`
 * helper, a daemonised git) escape both the leader check and the group check of pty-group-kill.
 * On Linux they are found by what they inherited: the throwaway `CLAUDE_CONFIG_DIR=<root>` in
 * their environment, or a cwd inside the throwaway temp cwd (#570 r13, C).
 *
 * macOS has no cheap equivalent (`ps eww` shows the environment of other processes only
 * partially and not at all for hardened binaries). There, containment is the process group plus
 * the remove-and-recheck loop of `removeUntrustedConfigRoot`; a process that leaves the group
 * and keeps writing is not stopped. This is a narrowed guarantee, recorded in the #570 report.
 *
 * Only pids and counts are ever returned or logged. An environment is read into memory, compared
 * with one exact entry and dropped.
 */

import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { isSignalablePid } from "./pty-group-kill.js";
import {
  type StartMsReader,
  START_TIME_TOLERANCE_MS,
  processStartMs,
} from "./pty-proc-identity.js";

export interface EscapeScanTarget {
  /** The throwaway `CLAUDE_CONFIG_DIR`. */
  root: string;
  /** The throwaway cwd, in every form claude may see it (as given and resolved). */
  cwds: string[];
}

export interface EscapeScanOptions {
  /** `/proc`; replaced by a fake tree in tests. */
  procDir?: string;
  /** Never reported: the daemon itself. */
  selfPid?: number;
}

const isLinuxProc = (procDir: string): boolean =>
  process.platform === "linux" || procDir !== "/proc";

/** True when `environ` (NUL-separated `KEY=value` entries) holds exactly `CLAUDE_CONFIG_DIR=<root>`. */
function environHasRoot(environ: Buffer, root: string): boolean {
  const wanted = `CLAUDE_CONFIG_DIR=${root}`;
  for (const entry of environ.toString("utf8").split("\0")) {
    if (entry === wanted) return true;
  }
  return false;
}

function cwdInside(cwd: string, cwds: readonly string[]): boolean {
  return cwds.some((dir) => cwd === dir || cwd.startsWith(`${dir}/`));
}

/**
 * Pids of live processes that carry this call's config root in their environment or run inside
 * its temp cwd. `[]` where `/proc` is not available. A process whose environment or cwd cannot be
 * read (another uid, gone mid-scan) is skipped: only our own children can be ours.
 */
export function findEscapees(
  { root, cwds }: EscapeScanTarget,
  { procDir = "/proc", selfPid = process.pid }: EscapeScanOptions = {},
): number[] {
  if (!isLinuxProc(procDir)) return [];
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === selfPid || !isSignalablePid(pid)) continue;
    let matched = false;
    try {
      matched = environHasRoot(readFileSync(`${procDir}/${name}/environ`), root);
    } catch {
      /* not readable: not ours, or gone */
    }
    if (!matched) {
      try {
        matched = cwdInside(readlinkSync(`${procDir}/${name}/cwd`), cwds);
      } catch {
        /* not readable: not ours, or gone */
      }
    }
    if (matched) found.push(pid);
  }
  return found;
}

export interface EscapeKillOptions extends EscapeScanOptions {
  signal?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
  startMs?: StartMsReader;
  termGraceMs?: number;
  killGraceMs?: number;
  pollMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stop every escapee of `target`: SIGTERM, then SIGKILL after `termGraceMs`, polling until the
 * scan comes back empty. A pid is signalled only while its start time is still the one read when
 * it was found, so a pid reused between the scan and the signal is left alone. Resolves the pids
 * still found after SIGKILL, or whose identity could not be checked; `[]` means none remain.
 */
export async function terminateEscapees(
  target: EscapeScanTarget,
  opts: EscapeKillOptions = {},
): Promise<number[]> {
  const {
    signal = process.kill,
    sleep = defaultSleep,
    startMs = processStartMs,
    termGraceMs = 2000,
    killGraceMs = 2000,
    pollMs = 20,
  } = opts;
  const first = findEscapees(target, opts);
  if (first.length === 0) return [];

  // The identity of each pid, fixed the moment it was found.
  const born = new Map(first.map((pid) => [pid, startMs(pid)] as const));
  const sameProcess = (pid: number): boolean => {
    const then = born.get(pid) ?? null;
    const now = startMs(pid);
    return then !== null && now !== null && Math.abs(now - then) <= START_TIME_TOLERANCE_MS;
  };
  const send = (name: NodeJS.Signals): void => {
    for (const pid of findEscapees(target, opts)) {
      // A pid first seen now has no recorded identity: it is recorded, and signalled next round.
      if (!born.has(pid)) {
        born.set(pid, startMs(pid));
        continue;
      }
      if (!sameProcess(pid)) continue;
      try {
        signal(pid, name);
      } catch {
        /* gone */
      }
    }
  };
  const remaining = async (budgetMs: number): Promise<number[]> => {
    for (let waited = 0; ; waited += pollMs) {
      const left = findEscapees(target, opts);
      if (left.length === 0 || waited >= budgetMs) return left;
      await sleep(pollMs);
    }
  };

  send("SIGTERM");
  if ((await remaining(termGraceMs)).length === 0) return [];
  send("SIGKILL");
  return remaining(killGraceMs);
}
