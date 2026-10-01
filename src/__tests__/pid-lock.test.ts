/**
 * #435: every reader-that-removes, writer and remover of `daemon.pid` shares a
 * project-scoped lock, so `cleanupPidFileIf()`'s read → unlink cannot land
 * between a concurrent `start`'s `checkExistingDaemon()` and `writePidFile()`.
 *
 * Contenders run in child processes: the lock is cross-process by design, and
 * within one process it is re-entrant.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquirePidLock, cleanupPidFileIf, getPidLockPath, releasePidLock } from "../pid";

const PID_MODULE = resolve(import.meta.dir, "..", "pid.ts");
// A PID that existed and is gone: a spawned and reaped child, not a constant
// that may be a live PID on a host with a large pid_max.
const reaped = Bun.spawnSync(["true"]);
const DEAD_PID = reaped.pid;

let dir: string;
let pidFile: string;
let lockFile: string;

beforeEach(() => {
  // A temp dir, never the project's real daemon.pid / daemon.lock.
  dir = mkdtempSync(join(tmpdir(), "ccplus-pidlock-"));
  pidFile = join(dir, "daemon.pid");
  lockFile = getPidLockPath(pidFile);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A child that takes the lock, signals it holds it (`<dir>/held`), keeps it
 * for `holdMs`, then — like `start` — writes its own PID and releases.
 */
function spawnStartLike(holdMs: number) {
  const script = `
    import { writeFileSync } from "node:fs";
    import { acquirePidLock, releasePidLock } from ${JSON.stringify(PID_MODULE)};
    const pidFile = ${JSON.stringify(pidFile)};
    const r = await acquirePidLock(pidFile, 5000);
    if (!r.ok) process.exit(3);
    writeFileSync(${JSON.stringify(join(dir, "held"))}, "1");
    await Bun.sleep(${holdMs});
    writeFileSync(pidFile, process.pid + "\\n");
    releasePidLock(pidFile);
  `;
  return Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "inherit" });
}

async function waitFor(path: string, maxMs = 5000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

describe("PID lock (#435)", () => {
  it("cleanupPidFileIf does not unlink while a start holds the lock between check and write", async () => {
    // The old daemon's file, as `stop` / `--replace-existing` find it after the drain.
    writeFileSync(pidFile, "4242\n");
    const child = spawnStartLike(600);
    try {
      await waitFor(join(dir, "held"));
      // The start is between its check and its write: removing now is the
      // residual window #435 is about.
      expect(await cleanupPidFileIf(4242, pidFile, 100)).toBe("locked");
      expect(readFileSync(pidFile, "utf-8").trim()).toBe("4242");
      expect(await child.exited).toBe(0);
      // Once released, the file names the new daemon and must survive.
      expect(await cleanupPidFileIf(4242, pidFile)).toBe("foreign");
      expect(readFileSync(pidFile, "utf-8").trim()).toBe(String(child.pid));
      expect(existsSync(lockFile)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("cleanupPidFileIf waits for a short hold and then proceeds", async () => {
    writeFileSync(pidFile, "4242\n");
    const child = spawnStartLike(150);
    try {
      await waitFor(join(dir, "held"));
      // The child writes its own PID before releasing: compare-and-unlink sees it.
      expect(await cleanupPidFileIf(4242, pidFile, 5000)).toBe("foreign");
      expect(await child.exited).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("a second contender is refused while the lock is held, with the holder's PID", async () => {
    const child = spawnStartLike(800);
    try {
      await waitFor(join(dir, "held"));
      const r = await acquirePidLock(pidFile, 100);
      expect(r).toEqual({ ok: false, holder: child.pid });
      expect(await child.exited).toBe(0);
      const r2 = await acquirePidLock(pidFile, 100);
      expect(r2.ok).toBe(true);
      releasePidLock(pidFile);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("concurrent contenders never overlap inside the lock", async () => {
    const log = join(dir, "log");
    writeFileSync(log, "");
    const script = `
      import { appendFileSync } from "node:fs";
      import { acquirePidLock, releasePidLock } from ${JSON.stringify(PID_MODULE)};
      const r = await acquirePidLock(${JSON.stringify(pidFile)}, 20000);
      if (!r.ok) process.exit(3);
      appendFileSync(${JSON.stringify(log)}, "in " + process.pid + "\\n");
      await Bun.sleep(40);
      appendFileSync(${JSON.stringify(log)}, "out " + process.pid + "\\n");
      releasePidLock(${JSON.stringify(pidFile)});
    `;
    const children = Array.from({ length: 6 }, () =>
      Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "inherit" }),
    );
    const codes = await Promise.all(children.map((c) => c.exited));
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(12);
    // Strict alternation: every "in" is followed by the same PID's "out".
    for (let i = 0; i < lines.length; i += 2) {
      expect(lines[i]).toStartWith("in ");
      expect(lines[i + 1]).toBe(lines[i].replace("in ", "out "));
    }
    expect(existsSync(lockFile)).toBe(false);
  }, 30_000);

  it("contenders taking over a stale lock together never overlap", async () => {
    const log = join(dir, "log");
    const script = `
      import { appendFileSync } from "node:fs";
      import { acquirePidLock, releasePidLock } from ${JSON.stringify(PID_MODULE)};
      const r = await acquirePidLock(${JSON.stringify(pidFile)}, 20000);
      if (!r.ok) process.exit(3);
      appendFileSync(${JSON.stringify(log)}, "in " + process.pid + "\\n");
      await Bun.sleep(15);
      appendFileSync(${JSON.stringify(log)}, "out " + process.pid + "\\n");
      releasePidLock(${JSON.stringify(pidFile)});
    `;
    for (let round = 0; round < 8; round++) {
      writeFileSync(log, "");
      writeFileSync(lockFile, `${DEAD_PID}\n`); // left by a crashed start
      const children = Array.from({ length: 8 }, () =>
        Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "inherit" }),
      );
      const codes = await Promise.all(children.map((c) => c.exited));
      expect(codes).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
      const lines = readFileSync(log, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(16);
      for (let i = 0; i < lines.length; i += 2) {
        expect(lines[i]).toStartWith("in ");
        expect(lines[i + 1]).toBe(lines[i].replace("in ", "out "));
      }
      expect(existsSync(lockFile)).toBe(false);
    }
  }, 60_000);

  it("a lock left by a dead process is stale and taken over", async () => {
    writeFileSync(lockFile, `${DEAD_PID}\n`);
    const r = await acquirePidLock(pidFile, 100);
    expect(r.ok).toBe(true);
    expect(readFileSync(lockFile, "utf-8").trim()).toBe(String(process.pid));
    releasePidLock(pidFile);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("an old steal guard left by a dead stealer whose PID was recycled does not wedge the lock", async () => {
    writeFileSync(lockFile, `${DEAD_PID}\n`);
    writeFileSync(`${lockFile}.steal`, "1\n"); // PID 1: alive, unrelated
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${lockFile}.steal`, old, old);
    const r = await acquirePidLock(pidFile, 500);
    expect(r.ok).toBe(true);
    releasePidLock(pidFile);
    expect(existsSync(`${lockFile}.steal`)).toBe(false);
  });

  it("an empty lock (an O_EXCL create not yet written) is not stale until it is old", async () => {
    writeFileSync(lockFile, "");
    expect(await acquirePidLock(pidFile, 100)).toEqual({ ok: false, holder: null });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile, old, old);
    expect((await acquirePidLock(pidFile, 100)).ok).toBe(true);
    releasePidLock(pidFile);
  });

  it("a lock naming this PID that this process does not hold is stale (recycled PID)", async () => {
    writeFileSync(lockFile, `${process.pid}\n`);
    const r = await acquirePidLock(pidFile, 100);
    expect(r.ok).toBe(true);
    releasePidLock(pidFile);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("is re-entrant within a process: cleanupPidFileIf under start's own hold proceeds", async () => {
    expect((await acquirePidLock(pidFile, 100)).ok).toBe(true);
    try {
      writeFileSync(pidFile, "4242\n");
      // `--replace-existing` holds the lock and then removes the old daemon's file.
      expect(await cleanupPidFileIf(4242, pidFile, 0)).toBe("removed");
      // The inner release must not drop the outer hold.
      expect(readFileSync(lockFile, "utf-8").trim()).toBe(String(process.pid));
    } finally {
      releasePidLock(pidFile);
    }
    expect(existsSync(lockFile)).toBe(false);
  });

  it("a process exiting while holding the lock leaves no lock file", async () => {
    const script = `
      import { acquirePidLock } from ${JSON.stringify(PID_MODULE)};
      const r = await acquirePidLock(${JSON.stringify(pidFile)}, 1000);
      process.exit(r.ok ? 7 : 3);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stderr: "inherit" });
    expect(await child.exited).toBe(7);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("checkExistingDaemon run while a start holds the lock reports that start, and leaves the file", async () => {
    // checkExistingDaemon reads the cwd's project: run it in a child whose cwd is the temp project.
    const proj = mkdtempSync(join(tmpdir(), "ccplus-pidlock-proj-"));
    const pf = join(proj, ".claude", "claudeclaw", "daemon.pid");
    try {
      const holder = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
          import { writeFileSync } from "node:fs";
          import { acquirePidLock } from ${JSON.stringify(PID_MODULE)};
          const r = await acquirePidLock(${JSON.stringify(pf)}, 1000);
          if (!r.ok) process.exit(3);
          writeFileSync(${JSON.stringify(pf)}, "${DEAD_PID}\\n"); // a stale file, mid-start
          writeFileSync(${JSON.stringify(join(proj, "held"))}, "1");
          await Bun.sleep(4000);
        `,
        ],
        { stderr: "inherit" },
      );
      try {
        await waitFor(join(proj, "held"));
        const check = Bun.spawn(
          [
            process.execPath,
            "-e",
            `
            import { checkExistingDaemon } from ${JSON.stringify(PID_MODULE)};
            console.log(String(await checkExistingDaemon()));
          `,
          ],
          { cwd: proj, stdout: "pipe", stderr: "inherit" },
        );
        const out = (await new Response(check.stdout).text()).trim();
        expect(out).toBe(String(holder.pid));
        expect(readFileSync(pf, "utf-8").trim()).toBe(String(DEAD_PID)); // not removed under the start
      } finally {
        holder.kill("SIGKILL");
      }
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }, 20_000);

  it("release does not remove a lock that is no longer ours", async () => {
    expect((await acquirePidLock(pidFile, 100)).ok).toBe(true);
    writeFileSync(lockFile, "1\n"); // replaced behind our back
    releasePidLock(pidFile);
    expect(readFileSync(lockFile, "utf-8").trim()).toBe("1");
  });
});
