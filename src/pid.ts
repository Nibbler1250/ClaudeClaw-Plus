import { writeFile, unlink, readFile } from "fs/promises";
import { join } from "path";

const PID_FILE = join(process.cwd(), ".claude", "claudeclaw", "daemon.pid");

export function getPidPath(): string {
  return PID_FILE;
}

/**
 * Check if a daemon is already running in this directory.
 * If a stale PID file exists (process dead), it gets cleaned up.
 * Returns the running PID if alive, or null.
 */
export async function checkExistingDaemon(): Promise<number | null> {
  let raw: string;
  try {
    raw = (await readFile(PID_FILE, "utf-8")).trim();
  } catch {
    return null; // no pid file
  }

  const pid = Number(raw);
  if (!pid || isNaN(pid)) {
    await cleanupPidFile();
    return null;
  }

  // #420: EPERM means alive-but-not-ours — never treat it as stale, or a
  // `start` by another user removes a live daemon's file and starts over it.
  if (isPidAlive(pid)) return pid;
  // process is dead, clean up stale pid file
  await cleanupPidFile();
  return null;
}

export async function writePidFile(): Promise<void> {
  await writeFile(PID_FILE, String(process.pid) + "\n");
}

/**
 * Wait until `pid` is gone, polling every `pollMs`, for at most `maxMs`.
 * Resolves true when the process exited (or never existed), false when it
 * is still alive at the deadline. Used by `stop` / `--replace-existing` so a
 * daemon draining its in-flight turns (#315) is not declared stopped — and
 * its PID file not removed — while it still owns the socket and the agents.
 */
export async function waitForPidExit(pid: number, maxMs: number, pollMs = 100): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    if (!isPidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

/**
 * `kill(pid, 0)` throws for two different reasons: `ESRCH` (no such process —
 * gone) and `EPERM` (it exists but is not ours). Only the first means gone
 * (#420); treating a foreign live PID as exited would let `stop` /
 * `--replace-existing` remove its file and start another daemon over it.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove `daemon.pid` only if it still names `expectedPid` (#420). Between
 * "the old daemon exited" and this unlink, a concurrent `start` may have
 * written its own PID into the file; unlinking unconditionally would drop
 * that daemon's file and let a later `start` launch a duplicate. Returns
 * whether the file was removed.
 */
export type PidFileCleanup = "removed" | "absent" | "foreign";
export async function cleanupPidFileIf(
  expectedPid: number,
  pidFile: string = PID_FILE,
): Promise<PidFileCleanup> {
  let raw: string;
  try {
    raw = (await readFile(pidFile, "utf-8")).trim();
  } catch {
    // The daemon removes its own file on a clean exit; "absent" is the
    // normal outcome of a graceful stop, not a sign of anything.
    return "absent";
  }
  // A corrupt file (non-numeric) names nobody: remove it, as `checkExistingDaemon` does.
  const current = Number(raw);
  if (!Number.isInteger(current) || current <= 0) {
    await unlink(pidFile).catch(() => undefined);
    return "removed";
  }
  if (current !== expectedPid) return "foreign";
  // TOCTOU between this read and the unlink is one syscall wide and accepted:
  // POSIX has no compare-and-unlink without a lock file, and the window used
  // to be the whole drain.
  await unlink(pidFile).catch(() => undefined);
  return "removed";
}

/**
 * How long `stop` / `--replace-existing` give a daemon to exit after SIGTERM:
 * its drain window plus a margin for the teardown itself. Settings may not be
 * loaded (or may belong to another project's daemon), hence the default.
 */
export function stopGraceMs(drainTurnsMs?: number): number {
  return (drainTurnsMs ?? 30_000) + 5_000;
}

/**
 * The `shutdown.drainTurnsMs` a daemon in `projectDir` is running with, read
 * straight from its `settings.json` (same validation as the loader: finite,
 * >= 0). `undefined` when the file or the field is absent or malformed, so
 * the caller falls back to the default grace. For `stopAll`, which stops
 * daemons of OTHER projects and must not under-run a longer drain they were
 * configured with, and for `stop` / `--replace-existing` before settings are
 * loaded.
 */
export async function readConfiguredDrainMs(projectDir: string): Promise<number | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(join(projectDir, ".claude", "claudeclaw", "settings.json"), "utf-8"),
    ) as { shutdown?: { drainTurnsMs?: unknown } };
    const v = raw?.shutdown?.drainTurnsMs;
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

export async function cleanupPidFile(): Promise<void> {
  try {
    await unlink(PID_FILE);
  } catch {
    // already gone
  }
}
