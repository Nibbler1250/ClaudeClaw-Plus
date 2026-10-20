import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { encodeCwdForProjectsDir } from "../bus/jsonl-line-types.js";
import { type EscapeScanTarget, terminateEscapees } from "../runner/pty-escape-scan.js";
import { type GroupTerminationOptions, terminateProcessGroup } from "../runner/pty-group-kill.js";
import {
  START_TIME_TOLERANCE_MS,
  type StartMsReader,
  cachedStartMs,
  processStartMs,
} from "../runner/pty-proc-identity.js";

export { processStartMs };

/**
 * An untrusted PTY one-shot writes nothing about the call under the operator's Claude config
 * root. Each call gets its own throwaway `CLAUDE_CONFIG_DIR`, so everything an interactive
 * claude writes about the prompt (transcript, history, paste cache, session files) lands
 * there and goes with it.
 * Credentials are not copied: `CLAUDE_SECURESTORAGE_CONFIG_DIR` points claude at the
 * operator's own credential store (read out of claude 2.1.304; see the spike doc).
 *
 * The only write outside the throwaway root is claude's own credential refresh into the
 * operator's credential store: claude refreshing the operator's own OAuth token, with no
 * prompt data in it. It is accepted. Its lock is `<credential dir>/.oauth_refresh.lock`, the one
 * the daemon's own claude takes, not a file under the throwaway root (spike doc, r12).
 */

/** Prefix of the per-call throwaway config root, a sibling of the temp cwd. */
export const ONESHOT_CONFIG_PREFIX = "claudeclaw-oneshot-cfg-";
/** Prefix of the per-call temp cwd. */
export const ONESHOT_CWD_PREFIX = "claudeclaw-oneshot-pty-";

/** Leftovers older than this are removed at daemon start. */
export const ONESHOT_SWEEP_MAX_AGE_MS = 10 * 60_000;

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

/**
 * The directory claude should read credentials from, so the throwaway config root
 * authenticates as the operator does. An explicit `CLAUDE_SECURESTORAGE_CONFIG_DIR` in the
 * caller's env is passed through as given. Otherwise it is the operator's
 * `CLAUDE_CONFIG_DIR`, or `""` when that is unset or empty: `""` means the default
 * (`~/.claude`, and the unsuffixed keychain service name on macOS). A relative directory
 * would resolve against whatever cwd the caller has, so it fails closed before any spawn.
 *
 * `env` is the child's env after the caller's policy (print's override replaces the whole
 * env, so it can lack the operator's `CLAUDE_CONFIG_DIR`); `daemonEnv` is the daemon's own,
 * consulted for what the policy env does not name. Without it an operator with a custom
 * config root would be sent to the default store.
 */
export function operatorSecureStorageDir(
  env: Record<string, string | undefined>,
  daemonEnv: Record<string, string | undefined> = {},
): string {
  const explicit = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? daemonEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const dir =
    explicit !== undefined
      ? explicit
      : (nonEmpty(env.CLAUDE_CONFIG_DIR) ?? nonEmpty(daemonEnv.CLAUDE_CONFIG_DIR) ?? "");
  if (dir !== "" && !isAbsolute(dir)) {
    throw new Error("untrusted PTY one-shot requires an absolute Claude config root");
  }
  return dir;
}

/** The cwd as given and as resolved: claude may record either. */
export function untrustedCwdForms(cwd: string): string[] {
  const forms = new Set([cwd]);
  try {
    forms.add(realpathSync(cwd));
  } catch {
    /* already gone */
  }
  return [...forms];
}

/** Where an interactive claude with this config root keeps the transcripts of `cwd`. */
export function untrustedPtyProjectDir(cwd: string, configRoot: string): string {
  return join(configRoot, "projects", encodeCwdForProjectsDir(realpathSync(cwd)));
}

/** Written into every root and temp cwd when it is created, so a sweep can tell a live call from a leftover. */
export const ONESHOT_OWNER_FILE = ".oneshot-owner.json";

/** Distinguishes this daemon run from an earlier one that had the same pid. */
export const DAEMON_INSTANCE = randomUUID();

export interface OwnerRecord {
  pid: number;
  /** Epoch ms the owner process started, when `ps` could say. */
  startMs: number | null;
  instance: string;
}

let selfOwner: OwnerRecord | undefined;
function selfOwnerRecord(): OwnerRecord {
  selfOwner ??= {
    pid: process.pid,
    startMs: processStartMs(process.pid),
    instance: DAEMON_INSTANCE,
  };
  return selfOwner;
}

/** Record this daemon as the owner of `dir`. Throws if it cannot be written. */
export function writeOwnerFile(dir: string): void {
  writeFileSync(join(dir, ONESHOT_OWNER_FILE), `${JSON.stringify(selfOwnerRecord())}\n`, {
    mode: 0o600,
  });
}

/**
 * What a directory's owner file says: a record, `missing` (no such file: a directory made before
 * the owner file existed), or `unreadable` (the file is there but cannot be read or understood).
 * The two must not be confused: a leftover with no owner file is swept by age, but one whose
 * owner file is damaged may belong to a live call, so it is quarantined (#570 r13, A).
 */
export type OwnerFile = OwnerRecord | "missing" | "unreadable";

export function readOwnerFile(dir: string): OwnerFile {
  let raw: string;
  try {
    raw = readFileSync(join(dir, ONESHOT_OWNER_FILE), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  try {
    const parsed = JSON.parse(raw) as OwnerRecord;
    if (!Number.isInteger(parsed.pid) || typeof parsed.instance !== "string") return "unreadable";
    return {
      pid: parsed.pid,
      startMs: typeof parsed.startMs === "number" ? parsed.startMs : null,
      instance: parsed.instance,
    };
  } catch {
    return "unreadable";
  }
}

/** Calls of this daemon that have not finished: their directories are never swept. */
const activeDirs = new Set<string>();
export function markOneShotDirActive(dir: string): void {
  activeDirs.add(dir);
}
export function releaseOneShotDir(dir: string): void {
  activeDirs.delete(dir);
}
/** Test seam: how many directories of unfinished calls are registered. */
export function activeOneShotDirCount(): number {
  return activeDirs.size;
}

/**
 * What is needed to stop a claude that outlived its retirement, and to keep its directories safe
 * meanwhile: the leader's pid with the start time it had at spawn, the temp cwd and its forms.
 */
export interface GroupSurvivor {
  pid: number;
  /** The leader's start time at spawn, null when it could not be read. */
  startMs: number | null;
  tempCwd?: string;
  cwds: string[];
  /** Retries made by the sweeper so far. */
  retries: number;
}

/**
 * Roots whose claude process group could not be stopped (the root may still be written into).
 * Keyed by root path. The sweeper signals them again every pass and drops an entry only once
 * the group, and anything that left it, is gone; until then neither directory is swept.
 */
const survivingGroups = new Map<string, GroupSurvivor>();
export function markGroupSurvivor(
  root: string,
  pid: number,
  extra: { startMs?: number | null; tempCwd?: string; cwds?: string[] } = {},
): void {
  survivingGroups.set(root, {
    pid,
    startMs: extra.startMs ?? null,
    tempCwd: extra.tempCwd,
    cwds: extra.cwds ?? [],
    retries: survivingGroups.get(root)?.retries ?? 0,
  });
}
export function groupSurvivorOf(root: string): number | undefined {
  return survivingGroups.get(root)?.pid;
}
/** Test seam: how many roots have an unstopped survivor. */
export function groupSurvivorCount(): number {
  return survivingGroups.size;
}
/** Test seam: forget every recorded survivor. */
export function resetGroupSurvivorsForTests(): void {
  survivingGroups.clear();
}
const protectedBySurvivor = (path: string): boolean => {
  for (const [root, survivor] of survivingGroups) {
    if (root === path || survivor.tempCwd === path) return true;
  }
  return false;
};

export interface SurvivorRetryDeps {
  terminate?: (pid: number, opts: GroupTerminationOptions) => Promise<boolean>;
  reap?: (target: EscapeScanTarget) => Promise<number[]>;
  startMs?: StartMsReader;
}

/**
 * Signal every recorded survivor again. Each is checked against the start time recorded at
 * spawn before any signal, so a pid that was reused is never touched; the leader is no longer
 * ours, so only its group is signalled. An entry is dropped once the group and everything that
 * left it are gone. A retry that fails is logged as metadata (pid, retry count, how many
 * processes), never paths or environment. Returns how many entries were cleared.
 */
export async function retrySurvivingGroups(deps: SurvivorRetryDeps = {}): Promise<number> {
  const terminate = deps.terminate ?? terminateProcessGroup;
  const reap = deps.reap ?? ((target: EscapeScanTarget) => terminateEscapees(target));
  const startMs = deps.startMs ?? cachedStartMs();
  let cleared = 0;
  for (const [root, survivor] of [...survivingGroups]) {
    survivor.retries++;
    try {
      const groupGone = await terminate(survivor.pid, {
        leaderStartMs: survivor.startMs,
        startMs,
        leaderAlive: () => false,
      });
      const escapees = await reap({ root, cwds: survivor.cwds });
      if (groupGone && escapees.length === 0) {
        survivingGroups.delete(root);
        cleared++;
      } else {
        console.error(
          `[oneshot] survivor of pid ${survivor.pid} still alive after retry ${survivor.retries} (group ${groupGone ? "gone" : "alive"}, ${escapees.length} outside it)`,
        );
      }
    } catch (error) {
      console.error(
        `[oneshot] survivor retry for pid ${survivor.pid} failed (${(error as NodeJS.ErrnoException)?.code ?? "error"})`,
      );
    }
  }
  return cleared;
}

/** The owner is gone: no such pid, or the pid now belongs to a process that started later. */
export function isOwnerDead(
  owner: OwnerRecord,
  deps: { kill?: (pid: number, signal: 0) => void; startMs?: (pid: number) => number | null } = {},
): boolean {
  if (owner.instance === DAEMON_INSTANCE) return false; // this daemon; `activeDirs` decides
  const kill = deps.kill ?? process.kill;
  try {
    kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  const now = (deps.startMs ?? processStartMs)(owner.pid);
  if (owner.startMs === null || now === null) return false; // cannot tell: assume it is the owner
  return Math.abs(now - owner.startMs) > START_TIME_TOLERANCE_MS;
}

/** Create the per-call temp cwd (mode 0700, owner file inside). Removed again on error. */
export function createUntrustedTempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), ONESHOT_CWD_PREFIX));
  try {
    chmodSync(dir, 0o700);
    writeOwnerFile(dir);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

/**
 * Create the per-call config root (mode 0700, next to the temp cwd) with the smallest
 * `.claude.json` that gets an interactive claude to its prompt: onboarding done, and the
 * throwaway cwd trusted in both of its forms. Throws if the root cannot be written; the
 * caller fails the call before any spawn. A root that was created is removed again on error.
 */
export function createUntrustedConfigRoot(cwds: string[]): string {
  const root = mkdtempSync(join(tmpdir(), ONESHOT_CONFIG_PREFIX));
  try {
    chmodSync(root, 0o700);
    writeOwnerFile(root);
    const projects: Record<string, unknown> = {};
    for (const cwd of cwds) {
      projects[cwd] = { hasTrustDialogAccepted: true, projectOnboardingSeenCount: 1 };
    }
    writeFileSync(
      join(root, ".claude.json"),
      `${JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", numStartups: 10, projects })}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return root;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_QUIET_MS = 200;
let quietMsDefault = DEFAULT_QUIET_MS;
/** Test seam: shorten the quiet wait of every removal (the test preload does). `null` restores it. */
export function setRootRemovalQuietMsForTests(ms: number | null): void {
  quietMsDefault = ms ?? DEFAULT_QUIET_MS;
}

export interface RemoveRootOptions {
  /** How long the root must stay gone before the removal counts. */
  quietMs?: number;
  /** Removal attempts before giving up. */
  maxPasses?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Remove the throwaway config root, and prove it stays removed. This is the second line of
 * defence. The first is retiring claude's whole process group and waiting for it to be gone
 * before this runs (pty-group-kill): bun-pty's kill() reports an exit it has not waited for,
 * so a dying claude or a git clone it started could write into the directory afterwards and
 * re-create it (seen live, r11 run 1). Here: remove, wait `quietMs`, look again, and repeat
 * while it comes back. Throws if it never stays gone (or the last removal failed), so a call
 * never reports an isolated success while prompt text sits on disk.
 */
export async function removeUntrustedConfigRoot(
  root: string,
  { quietMs = quietMsDefault, maxPasses = 12, sleep = defaultSleep }: RemoveRootOptions = {},
): Promise<void> {
  let lastError: unknown;
  for (let pass = 0; pass < maxPasses; pass++) {
    try {
      rmSync(root, { recursive: true, force: true });
      lastError = undefined;
    } catch (error) {
      lastError = error; // a writer added files mid-removal (ENOTEMPTY): try again
    }
    await sleep(quietMs);
    if (!existsSync(root)) return;
  }
  throw lastError ?? new Error("throwaway config root kept reappearing");
}

export interface SweepDeps {
  /** Replaces `process.getuid()`. */
  uid?: number;
  isOwnerDead?: (owner: OwnerRecord) => boolean;
  /** Replaces `ps` for the owners' start times; asked once per pid per pass. */
  startMs?: StartMsReader;
}

/**
 * Remove `claudeclaw-oneshot-cfg-*` and `claudeclaw-oneshot-pty-*` directories under `dir`
 * that a crashed or failed call left behind. A directory is swept only when ALL hold:
 * it is older than `maxAgeMs`; it belongs to this uid; no call of this daemon is still using
 * it; no claude of this daemon that outlived its retirement may still write into it; and its
 * owner (the daemon whose pid and start time its owner file names) is dead. A directory with
 * no owner file at all (made before the owner file existed) falls back to the age rule. One
 * whose owner file is there but cannot be read or understood is quarantined: logged once, never
 * removed here, because it may belong to a live call. Symlinks and plain files with the prefix
 * are left alone. Returns how many were removed; a failure on one entry does not stop the rest.
 */
export function sweepStaleOneShotDirs(
  dir = tmpdir(),
  now = Date.now(),
  maxAgeMs = ONESHOT_SWEEP_MAX_AGE_MS,
  deps: SweepDeps = {},
): number {
  const uid = deps.uid ?? process.getuid?.();
  // One `ps` per pid for the whole pass: the same owner pid names many directories.
  const startMs = cachedStartMs(deps.startMs);
  const ownerDead = deps.isOwnerDead ?? ((owner: OwnerRecord) => isOwnerDead(owner, { startMs }));
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(ONESHOT_CONFIG_PREFIX) && !name.startsWith(ONESHOT_CWD_PREFIX)) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || now - stat.mtimeMs <= maxAgeMs) continue;
      if (uid !== undefined && stat.uid !== uid) continue; // not ours to remove
      if (activeDirs.has(path) || protectedBySurvivor(path)) continue;
      // Another live daemon's call is kept. This daemon's own finished call (not `activeDirs`)
      // whose removal failed is a leftover too, so its owner file does not protect it.
      const owner = readOwnerFile(path);
      if (owner === "unreadable") {
        if (!quarantined.has(path)) {
          quarantined.add(path);
          console.warn("[oneshot] temp dir quarantined: owner file unreadable, not removed");
        }
        continue;
      }
      if (owner !== "missing" && owner.instance !== DAEMON_INSTANCE && !ownerDead(owner)) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch (error) {
      console.warn(
        `[oneshot] stale temp dir not removed (${(error as NodeJS.ErrnoException).code ?? "error"})`,
      );
    }
  }
  return removed;
}

/** Directories already reported as quarantined, so a pass every ten minutes does not repeat itself. */
const quarantined = new Set<string>();

/** How often a running daemon looks for leftovers. */
export const ONESHOT_SWEEP_INTERVAL_MS = 10 * 60_000;

export interface SweeperDeps {
  setInterval?: (callback: () => void, ms: number) => { unref?: () => unknown };
  sweep?: () => number;
  /** Signals recorded survivors again; runs before each timed sweep. */
  retrySurvivors?: () => Promise<number>;
}

let sweeper: { unref?: () => unknown } | undefined;

/**
 * Sweep once now, then every `ONESHOT_SWEEP_INTERVAL_MS` while the daemon is up (unref'd, so
 * it never keeps the process alive). A late cleanup that failed is retried by a later pass
 * instead of waiting for the next daemon start. Registers the timer once. Returns how many
 * directories the first pass removed.
 */
export function startOneShotSweeper(deps: SweeperDeps = {}): number {
  const sweep = deps.sweep ?? (() => sweepStaleOneShotDirs());
  const first = sweep();
  if (sweeper === undefined) {
    const register = deps.setInterval ?? ((callback, ms) => setInterval(callback, ms));
    const retry = deps.retrySurvivors ?? (() => retrySurvivingGroups());
    const failed = (what: string, error: unknown): void =>
      console.error(
        `[oneshot] ${what} failed (${(error as NodeJS.ErrnoException)?.code ?? (error as Error)?.name ?? "error"})`,
      );
    const timer = register(() => {
      // Survivors are signalled again on every pass. A root with a recorded survivor is skipped
      // by the sweep below, so the two need not run in order.
      void retry()
        .then((stopped) => {
          if (stopped > 0) console.log(`[oneshot] stopped ${stopped} surviving claude group(s)`);
        })
        .catch((error) => failed("survivor retry", error));
      try {
        const n = sweep();
        if (n > 0) console.log(`[oneshot] removed ${n} stale one-shot temp dir(s)`);
      } catch (error) {
        // The next pass retries it; this says so instead of staying silent.
        failed("sweeper pass", error);
      }
    }, ONESHOT_SWEEP_INTERVAL_MS);
    timer.unref?.();
    sweeper = timer;
  }
  return first;
}

/** Test seam: forget the registered timer so the next `startOneShotSweeper` registers again. */
export function resetOneShotSweeperForTests(): void {
  sweeper = undefined;
  quarantined.clear();
}
