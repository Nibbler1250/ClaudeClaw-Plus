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

  try {
    process.kill(pid, 0); // signal 0 = just check if alive
    return pid;
  } catch {
    // process is dead, clean up stale pid file
    await cleanupPidFile();
    return null;
  }
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
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await Bun.sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
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
