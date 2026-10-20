import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PtyProcessOptions, spawnPty } from "./pty-process.js";

/**
 * #570 r12 (A): retiring a PTY child stops its whole process group and proves it. These run a
 * real shell through the real PTY path (no claude), with a background child that survives the
 * hangup bun-pty's close() delivers, the way a daemonised helper or a git clone would.
 */

let dir: string;
const strays: number[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pty-group-"));
});
afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  for (const start = Date.now(); !condition(); ) {
    if (Date.now() - start > ms) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Spawn `sh -c script` as an untrusted PTY child; the script writes `$!` of its background job to `bg`. */
async function spawnShell(script: string, extra: Partial<PtyProcessOptions> = {}) {
  const bgFile = join(dir, "bg.pid");
  const child = await spawnPty({
    sessionId: "",
    cwd: dir,
    isolation: "untrusted",
    env: { PATH: "/usr/bin:/bin" },
    security: { level: "moderate", allowedTools: [], disallowedTools: [] },
    _commandOverride: "/bin/sh",
    _argsOverride: ["-c", script.replaceAll("$BG", bgFile)],
    _skipReadySettle: true,
    ...extra,
  });
  await until(() => existsSync(bgFile) && readFileSync(bgFile, "utf8").trim() !== "");
  const bg = Number(readFileSync(bgFile, "utf8").trim());
  strays.push(bg, child.pid);
  return { child, bg };
}

// The shell itself dies of the hangup; the background job ignores it and outlives the closed PTY.
const HUP_PROOF_BG = "(trap '' HUP; exec sleep 60) & echo $! > $BG; sleep 60";

describe("retiring a PTY child", () => {
  it("is the leader of its own process group (pgid equals pid)", async () => {
    const { child } = await spawnShell(HUP_PROOF_BG);
    try {
      const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(child.pid)]).toString());
      expect(pgid).toBe(child.pid);
    } finally {
      await child.dispose();
    }
  });

  it("leaves neither the shell nor its background child alive, on SIGTERM and without waiting out the grace", async () => {
    const { child, bg } = await spawnShell(HUP_PROOF_BG, {
      _groupTermination: { termGraceMs: 4000, killGraceMs: 2000, pollMs: 20 },
    });
    expect(alive(child.pid)).toBe(true);
    expect(alive(bg)).toBe(true);
    const started = Date.now();
    await child.dispose();
    // Went red (the sleep still alive) with the group signal sent to the leader only, or the
    // wait for the group dropped.
    expect(alive(child.pid)).toBe(false);
    expect(alive(bg)).toBe(false);
    // Went red at ~4.4 s with the SIGTERM removed: SIGKILL, after the grace, was doing the work.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("twin: with the group kill off the background child survives (so the test above can fail)", async () => {
    const { child, bg } = await spawnShell(HUP_PROOF_BG, { terminateGroup: false });
    await child.dispose();
    // bun-pty's kill() returns before the hangup has been delivered, so the shell is still
    // dying here; it does go. The background child does not.
    await until(() => !alive(child.pid));
    expect(alive(bg)).toBe(true); // cleaned up in afterEach
  });

  it("escalates to SIGKILL for a group that ignores SIGTERM and SIGHUP", async () => {
    const { child, bg } = await spawnShell(
      "(trap '' HUP TERM; exec sleep 60) & echo $! > $BG; sleep 60",
      {
        _groupTermination: { termGraceMs: 300, killGraceMs: 3000, pollMs: 20 },
      },
    );
    const started = Date.now();
    await child.dispose();
    // Went red (the sleep still alive) with the SIGKILL escalation removed.
    expect(alive(bg)).toBe(false);
    expect(alive(child.pid)).toBe(false);
    // The SIGTERM grace was spent before SIGKILL went out.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("sweeps the descendants of a child that already exited on its own", async () => {
    const { child, bg } = await spawnShell("(trap '' HUP; exec sleep 60) & echo $! > $BG");
    await until(() => !child.isAlive());
    expect(alive(bg)).toBe(true); // the leader is gone, its background child is not
    await child.dispose();
    expect(alive(bg)).toBe(false);
  });

  it("does not signal the group of a child that exited long ago (its pid may be someone else's now)", async () => {
    let clock = 1_000_000;
    const { child, bg } = await spawnShell("(trap '' HUP; exec sleep 60) & echo $! > $BG", {
      _now: () => clock,
    });
    await until(() => !child.isAlive());
    clock += 120_000;
    await child.dispose();
    // Went red (the sleep killed) with the age guard removed.
    expect(alive(bg)).toBe(true); // cleaned up in afterEach
  });

  it("reports the pid when the group cannot be made to disappear, and does not claim success", async () => {
    const survived: number[] = [];
    // A kernel that always answers "still there" and ignores every signal.
    const stubborn = (_pid: number, _signal: unknown): void => {};
    const { child } = await spawnShell(HUP_PROOF_BG, {
      onGroupSurvived: (pid) => survived.push(pid),
      _groupTermination: {
        signal: stubborn as never,
        termGraceMs: 60,
        killGraceMs: 60,
        pollMs: 20,
        liveMembers: () => undefined,
      },
    });
    await child.dispose();
    // Went red ([] received) with the report to onGroupSurvived removed.
    expect(survived).toEqual([child.pid]);
  });

  it("calls no survivor hook when the group is gone", async () => {
    const survived: number[] = [];
    const { child } = await spawnShell(HUP_PROOF_BG, {
      onGroupSurvived: (pid) => survived.push(pid),
    });
    await child.dispose();
    expect(survived).toEqual([]);
  });
});
