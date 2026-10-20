import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { encodeCwdForProjectsDir } from "../bus/jsonl-line-types.js";

/**
 * An untrusted PTY one-shot never touches the operator's Claude config root. Each call gets
 * its own throwaway `CLAUDE_CONFIG_DIR`, so everything an interactive claude writes about the
 * prompt (transcript, history, paste cache, session files) lands there and goes with it.
 * Credentials are not copied: `CLAUDE_SECURESTORAGE_CONFIG_DIR` points claude at the
 * operator's own credential store (read out of claude 2.1.304; see the spike doc).
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
 */
export function operatorSecureStorageDir(env: Record<string, string | undefined>): string {
  const explicit = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const dir = explicit !== undefined ? explicit : (nonEmpty(env.CLAUDE_CONFIG_DIR) ?? "");
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
 * Remove the throwaway config root, and prove it stays removed. The claude that used it is
 * retired before this runs, but a dying claude (or a git clone it started) can write into
 * the directory for a moment longer, which re-creates it (seen live, r11 run 1: the first
 * check after `rmSync` found the root again). So: remove, wait `quietMs`, look again, and
 * repeat while it comes back. Throws if it never stays gone (or the last removal failed), so
 * a call never reports an isolated success while prompt text sits on disk.
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

/**
 * Daemon start: remove `claudeclaw-oneshot-cfg-*` and `claudeclaw-oneshot-pty-*` directories
 * under `dir` that are older than `maxAgeMs`. A crash between create and cleanup leaves one
 * behind and nothing else would ever retry it. Symlinks and plain files with the prefix are
 * left alone. Returns how many were removed; a failure on one entry does not stop the rest.
 */
export function sweepStaleOneShotDirs(
  dir = tmpdir(),
  now = Date.now(),
  maxAgeMs = ONESHOT_SWEEP_MAX_AGE_MS,
): number {
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
