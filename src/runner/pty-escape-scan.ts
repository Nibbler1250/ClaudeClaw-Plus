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

import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { isSignalablePid } from "./pty-group-kill.js";
import {
  type StartMsReader,
  START_TIME_TOLERANCE_MS,
  processStartMs,
} from "./pty-proc-identity.js";

export interface EscapeScanTarget {
  /** The throwaway `CLAUDE_CONFIG_DIR`. Null: look only at working directories. */
  root: string | null;
  /** The throwaway cwd, in every form claude may see it (as given and resolved). */
  cwds: string[];
}

export interface EscapeScanOptions {
  /** `/proc`; replaced by a fake tree in tests. */
  procDir?: string;
  /** Never reported: the daemon itself. */
  selfPid?: number;
  /** Replaces `process.getuid()`: only processes owned by this uid are ours to read. */
  uid?: number;
}

/**
 * What one pass over `/proc` found. `unknown` is true when a process of ours could not be read, so
 * `pids` may be short: a caller must not read an empty `pids` as "nothing escaped" (#570 r14, A).
 */
export interface EscapeScan {
  pids: number[];
  unknown: boolean;
}

/** The scan could not tell whether something escaped. Callers treat it as a survivor. */
export class EscapeScanUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EscapeScanUnknownError";
  }
}

const isLinuxProc = (procDir: string): boolean =>
  process.platform === "linux" || procDir !== "/proc";

/** True when `environ` (NUL-separated `KEY=value` entries) holds exactly `CLAUDE_CONFIG_DIR=<root>`. */
function environHasRoot(environ: Buffer, root: string | null): boolean {
  if (root === null) return false;
  const wanted = `CLAUDE_CONFIG_DIR=${root}`;
  for (const entry of environ.toString("utf8").split("\0")) {
    if (entry === wanted) return true;
  }
  return false;
}

function cwdInside(cwd: string, cwds: readonly string[]): boolean {
  return cwds.some((dir) => cwd === dir || cwd.startsWith(`${dir}/`));
}

const isGone = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ESRCH";
};

/**
 * Pids of live processes that carry this call's config root in their environment or run inside
 * its temp cwd; nothing where `/proc` is not available. Fails closed (#570 r14, A): a `/proc`
 * that cannot be listed throws, and a process owned by our uid whose environment or cwd cannot be
 * read for any reason but its having gone (ENOENT, ESRCH) makes the result `unknown`. Processes of
 * other uids are skipped: only our own children can be ours.
 */
export function findEscapees(
  { root, cwds }: EscapeScanTarget,
  { procDir = "/proc", selfPid = process.pid, uid = process.getuid?.() }: EscapeScanOptions = {},
): EscapeScan {
  const found: number[] = [];
  if (!isLinuxProc(procDir)) return { pids: found, unknown: false };
  let unknown = false;
  const names = readdirSync(procDir); // a throw here is "could not look": not an empty answer
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === selfPid || !isSignalablePid(pid)) continue;
    try {
      if (uid !== undefined && statSync(`${procDir}/${name}`).uid !== uid) continue;
    } catch (error) {
      if (!isGone(error)) unknown = true; // cannot even say whose it is
      continue;
    }
    let matched = false;
    let unreadable = false;
    try {
      matched = environHasRoot(readFileSync(`${procDir}/${name}/environ`), root);
    } catch (error) {
      if (!isGone(error)) unreadable = true;
    }
    if (!matched) {
      try {
        matched = cwdInside(readlinkSync(`${procDir}/${name}/cwd`), cwds);
      } catch (error) {
        if (!isGone(error)) unreadable = true;
      }
    }
    if (matched) found.push(pid);
    else if (unreadable) unknown = true;
  }
  return { pids: found, unknown };
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
 * Throws `EscapeScanUnknownError` when the last scan found nothing but could not read a process of
 * ours (or `/proc` itself): "nothing found" is then not an answer (#570 r14, A).
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
  const settled = (scan: EscapeScan): number[] => {
    if (scan.pids.length === 0 && scan.unknown) {
      throw new EscapeScanUnknownError("a process of ours could not be read; escapees unknown");
    }
    return scan.pids;
  };
  const first = findEscapees(target, opts);
  if (first.pids.length === 0 && !first.unknown) return [];

  // The identity of each pid, fixed the moment it was found.
  const born = new Map(first.pids.map((pid) => [pid, startMs(pid)] as const));
  const sameProcess = (pid: number): boolean => {
    const then = born.get(pid) ?? null;
    const now = startMs(pid);
    return then !== null && now !== null && Math.abs(now - then) <= START_TIME_TOLERANCE_MS;
  };
  const send = (name: NodeJS.Signals): void => {
    for (const pid of findEscapees(target, opts).pids) {
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
  const remaining = async (budgetMs: number): Promise<EscapeScan> => {
    for (let waited = 0; ; waited += pollMs) {
      const left = findEscapees(target, opts);
      if ((left.pids.length === 0 && !left.unknown) || waited >= budgetMs) return left;
      await sleep(pollMs);
    }
  };

  send("SIGTERM");
  const afterTerm = await remaining(termGraceMs);
  if (afterTerm.pids.length === 0 && !afterTerm.unknown) return [];
  send("SIGKILL");
  return settled(await remaining(killGraceMs));
}
