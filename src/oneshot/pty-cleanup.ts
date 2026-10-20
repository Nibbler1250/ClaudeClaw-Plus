import { spawnSync } from "node:child_process";
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

/** Start time of `pid` from `ps -o lstart=` (1 s resolution), or null when it cannot be read. */
export function processStartMs(pid: number): number | null {
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

function readOwnerFile(dir: string): OwnerRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, ONESHOT_OWNER_FILE), "utf8")) as OwnerRecord;
    if (!Number.isInteger(parsed.pid) || typeof parsed.instance !== "string") return undefined;
    return {
      pid: parsed.pid,
      startMs: typeof parsed.startMs === "number" ? parsed.startMs : null,
      instance: parsed.instance,
    };
  } catch {
    return undefined;
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
 * Roots whose claude process group could not be stopped (the root may still be written into).
 * Keyed by root path; the value is the pid that outlived SIGKILL.
 */
const survivingGroups = new Map<string, number>();
export function markGroupSurvivor(root: string, pid: number): void {
  survivingGroups.set(root, pid);
}
export function groupSurvivorOf(root: string): number | undefined {
  return survivingGroups.get(root);
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
  return Math.abs(now - owner.startMs) > 2000;
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
}

/**
 * Remove `claudeclaw-oneshot-cfg-*` and `claudeclaw-oneshot-pty-*` directories under `dir`
 * that a crashed or failed call left behind. A directory is swept only when ALL hold:
 * it is older than `maxAgeMs`; it belongs to this uid; no call of this daemon is still using
 * it; and its owner (the daemon whose pid and start time its owner file names) is dead. A
 * directory without a readable owner file (made before the owner file existed) falls back to
 * the age rule. Symlinks and plain files with the prefix are left alone. Returns how many
 * were removed; a failure on one entry does not stop the rest.
 */
export function sweepStaleOneShotDirs(
  dir = tmpdir(),
  now = Date.now(),
  maxAgeMs = ONESHOT_SWEEP_MAX_AGE_MS,
  deps: SweepDeps = {},
): number {
  const uid = deps.uid ?? process.getuid?.();
  const ownerDead = deps.isOwnerDead ?? isOwnerDead;
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
      if (activeDirs.has(path)) continue;
      // Another live daemon's call is kept. This daemon's own finished call (not `activeDirs`)
      // whose removal failed is a leftover too, so its owner file does not protect it.
      const owner = readOwnerFile(path);
      if (owner && owner.instance !== DAEMON_INSTANCE && !ownerDead(owner)) continue;
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

/** How often a running daemon looks for leftovers. */
export const ONESHOT_SWEEP_INTERVAL_MS = 10 * 60_000;

export interface SweeperDeps {
  setInterval?: (callback: () => void, ms: number) => { unref?: () => unknown };
  sweep?: () => number;
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
    const timer = register(() => {
      try {
        const n = sweep();
        if (n > 0) console.log(`[oneshot] removed ${n} stale one-shot temp dir(s)`);
      } catch {
        /* next pass retries */
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
}
