import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyExitUnconfirmedError, type PtyProcessOptions, spawnPty } from "./pty-process.js";
import { processStartMs, readPidIdentity } from "./pty-proc-identity.js";

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
  // A live look once the background child exists (a turn's start and end make it in production):
  // only members identified while the leader lived vouch for its group once it is gone (#581 cp9,
  // option B). The spawn hand-over alone can run before the shell forks. Since #581 decision 2 it
  // reads libproc in microseconds rather than a `ps` in tens of ms, and it then lists the leader
  // only: these tests failed about 1 run in 2 that way, each SIGTERM withheld from the HUP-proof
  // child of a leader already gone. Not on a child whose OS is a stand-in.
  const fakeOs = ["_signalPid", "_readPidIdentity", "_readPgid", "_liveMembers"].some(
    (seam) => seam in extra,
  );
  if (!fakeOs) (child as unknown as { _noteLiveGroup(): void })._noteLiveGroup();
  return { child, bg };
}

// The shell itself dies of the hangup; the background job ignores it and outlives the closed PTY.
const HUP_PROOF_BG = "(trap '' HUP; exec sleep 60) & echo $! > $BG; sleep 60";

// A shell that exits at once, leaving a HUP-proof background child. The shell does not exit until
// the child has installed its trap and said so: the pid file is written at the fork, before the
// trap, and a hangup that arrives first (the shell is a session leader) kills the child, which
// flaked these tests about 1 run in 8. Nor does it exit until told to (`$BG.go`, see
// `learnThenExit`).
const BG_THEN_EXIT =
  "(trap '' HUP; : > $BG.ready; exec sleep 60) & echo $! > $BG; while [ ! -e $BG.ready ] || [ ! -e $BG.go ]; do sleep 0.02; done";

/**
 * Let the child of `BG_THEN_EXIT` exit on its own, after a live look has identified its group.
 * Since #581 cp9 (H2) only members identified while the leader lived vouch for its group once it
 * is gone; the exit event does not. Holding the shell until `go` keeps its leader alive through
 * the spawn hand-over look: without it the shell could exit first, nothing was ever learned, and
 * the retirement held to its 7 s deadline (the cp9 flake). The hand-over usually lists the
 * background child already; the explicit look (a turn's start and end make it in production)
 * covers a hand-over that ran before the fork. Removing it alone stays green for that reason.
 */
async function learnThenExit(child: Awaited<ReturnType<typeof spawnPty>>): Promise<void> {
  const ready = join(dir, "bg.pid.ready");
  await until(() => existsSync(ready));
  (child as unknown as { _noteLiveGroup(): void })._noteLiveGroup();
  writeFileSync(join(dir, "bg.pid.go"), "");
  await until(() => !child.isAlive());
}

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
      _exitGraceMs: 4000,
      _exitCapMs: 6000,
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

  it("escalates to SIGKILL for a group that ignores SIGTERM and SIGHUP", async () => {
    const { child, bg } = await spawnShell(
      "(trap '' HUP TERM; exec sleep 60) & echo $! > $BG; sleep 60",
      {
        _exitGraceMs: 300,
        _exitCapMs: 3300,
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
    const { child, bg } = await spawnShell(BG_THEN_EXIT);
    await learnThenExit(child);
    expect(alive(bg)).toBe(true); // the leader is gone, its background child is not
    await child.dispose();
    expect(alive(bg)).toBe(false);
  });

  it("signals the group, not the bare pid, of a child that exited on its own with no start time recorded, during the dispose that follows", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const sent: Array<[number, unknown]> = [];
      // The pid still answers `kill(pid, 0)` and its identity cannot be read: the one case in
      // which only the first-termination flag lets `-pid` go out. Nothing is really signalled.
      const kernel = (pid: number, name: unknown): void => {
        if (name !== 0) sent.push([pid, name]);
      };
      const { child } = await spawnShell("echo $$ > $BG", {
        _readPidIdentity: () => null,
        _signalPid: kernel as never,
        _liveMembers: () => undefined,
        _exitGraceMs: 40,
        _exitCapMs: 100,
      });
      await until(() => !child.isAlive());
      // The kernel never lets the pid go, so the retirement is (rightly) unconfirmed.
      await expect(child.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
      // Went red ([] sent) with `firstTermination` not passed by dispose.
      expect(sent).toEqual([
        [-child.pid, "SIGTERM"],
        [-child.pid, "SIGKILL"],
      ]);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("does not signal a group that answers on the pgid of a leader that left no group behind (it may be someone else's now)", async () => {
    const survivors: string[] = [];
    const sent: Array<[number, unknown]> = [];
    // At the leader's exit nothing answers on `-pid`; afterwards something does. A saved identity
    // says nothing about a group whose leader is gone, so nothing is signalled and the retirement
    // stays unconfirmed (plan "Signal authority", point 2). No age is involved.
    let groupAnswers = false;
    const kernel = (pid: number, name: unknown): void => {
      if (name !== 0) {
        sent.push([pid, name]);
        return;
      }
      if (pid === -child.pid && groupAnswers) return;
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    };
    const { child } = await spawnShell("echo $$ > $BG", {
      _readPidIdentity: () => "recorded-at-spawn",
      _signalPid: kernel as never,
      _liveMembers: () => undefined,
      _exitGraceMs: 40,
      _exitCapMs: 100,
      onGroupSurvived: (_pid, _start, cause) => survivors.push(cause),
    });
    await until(() => !child.isAlive());
    groupAnswers = true;
    await expect(child.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
    // Went red (signals sent) with the continuity rule replaced by "a recorded identity is enough".
    expect(sent).toEqual([]);
    expect(survivors).toEqual(["group"]);
  });

  it("still looks for descendants that left the group when the child exited long ago, with only the time that is left", async () => {
    const budgets: number[] = [];
    const { child } = await spawnShell(BG_THEN_EXIT, {
      reapEscapees: async (leader) => {
        budgets.push(leader.remainingMs);
        return [];
      },
    });
    await learnThenExit(child);
    await child.dispose();
    // The scan ran once, and it was handed what is left of the one 7000 ms deadline.
    expect(budgets.length).toBe(1);
    expect(budgets[0]).toBeGreaterThan(0);
    expect(budgets[0]).toBeLessThanOrEqual(7000);
  });

  it("reports the pid when the group cannot be made to disappear, and does not claim success", async () => {
    const survived: number[] = [];
    // A kernel that always answers "still there" and ignores every signal.
    const stubborn = (_pid: number, _signal: unknown): void => {};
    const { child } = await spawnShell(HUP_PROOF_BG, {
      onGroupSurvived: (pid) => survived.push(pid),
      _signalPid: stubborn as never,
      _liveMembers: () => undefined,
      _exitGraceMs: 60,
      _exitCapMs: 120,
    });
    // Went red (resolved) with the rejection removed: the child is still there.
    await expect(child.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
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

// #570 r13 (A, B, C): what retirement does with the recorded identity, a failing hook and the scan.
describe("retirement and the recorded identity", () => {
  it("signals nothing through the group path when the pid's identity is not the one recorded at spawn", async () => {
    const sent: Array<[number, unknown]> = [];
    const recorder = (pid: number, name: unknown): void => {
      if (name !== 0) sent.push([pid, name]);
      else process.kill(pid, 0);
    };
    let reused = false;
    const { child, bg } = await spawnShell(HUP_PROOF_BG, {
      _signalPid: recorder as never,
      _readPidIdentity: () => (reused ? "another-process" : "recorded-at-spawn"),
      _exitGraceMs: 200,
      _exitCapMs: 400,
    });
    reused = true; // the pid "now" belongs to another process
    await child.dispose();
    expect(sent).toEqual([]);
    expect(alive(bg)).toBe(true); // nothing signalled it; cleaned up in afterEach
  });

  it("hands the survivor hook the start time recorded at spawn", async () => {
    const seen: Array<[number, number | null]> = [];
    const { child } = await spawnShell(HUP_PROOF_BG, {
      onGroupSurvived: (pid, startMs) => seen.push([pid, startMs]),
      _readPidIdentity: readPidIdentity,
      _signalPid: ((_pid: number, _name: unknown): void => {}) as never,
      _liveMembers: () => undefined,
      _exitGraceMs: 60,
      _exitCapMs: 120,
    });
    const readNow = processStartMs(child.pid); // the same reader, while the child is alive
    await expect(child.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
    expect(seen.length).toBe(1);
    const [pid, startMs] = seen[0] as [number, number | null];
    expect(pid).toBe(child.pid);
    expect(startMs).not.toBeNull();
    expect(startMs).toBe(readNow);
  });

  it("fails closed when the survivor hook throws: it is logged and dispose rejects all the same", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { child } = await spawnShell(HUP_PROOF_BG, {
        onGroupSurvived: () => {
          throw new Error("could not record");
        },
        _readPidIdentity: readPidIdentity,
        _signalPid: ((_pid: number, _name: unknown): void => {}) as never,
        _liveMembers: () => undefined,
        _exitGraceMs: 60,
        _exitCapMs: 120,
      });
      // A hook failure can never turn a survivor into a success, or into any other error: the
      // supervisor quarantines on this exact type.
      await expect(child.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
      const logged = error.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
      expect(logged).toContain("survivor hook threw");
    } finally {
      error.mockRestore();
    }
  });

  it("reports a process outside the group that the scan could not stop, and a scan that threw", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const reported: number[] = [];
      const left = await spawnShell(HUP_PROOF_BG, {
        onGroupSurvived: (pid) => reported.push(pid),
        reapEscapees: async () => [7777],
      });
      await expect(left.child.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
      expect(reported).toEqual([left.child.pid]);

      reported.length = 0;
      const threw = await spawnShell(HUP_PROOF_BG, {
        onGroupSurvived: (pid) => reported.push(pid),
        reapEscapees: async () => {
          throw new Error("scan failed");
        },
      });
      await expect(threw.child.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
      expect(reported).toEqual([threw.child.pid]);
    } finally {
      error.mockRestore();
    }
  });

  it("names the cause to the survivor hook: group, escapee, or a scan that could not tell", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const causes: string[] = [];
      const hook = (_pid: number, _start: number | null, cause: string): void => {
        causes.push(cause);
      };
      const stubborn = {
        _signalPid: ((_pid: number, _name: unknown): void => {}) as never,
        _liveMembers: () => undefined,
        _exitGraceMs: 60,
        _exitCapMs: 120,
      };
      const group = await spawnShell(HUP_PROOF_BG, { onGroupSurvived: hook, ...stubborn });
      await expect(group.child.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
      const escapee = await spawnShell(HUP_PROOF_BG, {
        onGroupSurvived: hook,
        reapEscapees: async () => [7777],
      });
      await expect(escapee.child.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
      const unknown = await spawnShell(HUP_PROOF_BG, {
        onGroupSurvived: hook,
        reapEscapees: async () => {
          throw new Error("could not read /proc");
        },
      });
      await expect(unknown.child.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
      // Went red with the escapee cause no longer set.
      expect(causes).toEqual(["group", "escapee", "scan-unknown"]);
    } finally {
      error.mockRestore();
    }
  });

  it("calls no survivor hook when the group is gone and the scan finds nothing", async () => {
    const reported: number[] = [];
    let scans = 0;
    const { child } = await spawnShell(HUP_PROOF_BG, {
      onGroupSurvived: (pid) => reported.push(pid),
      reapEscapees: async () => {
        scans++;
        return [];
      },
    });
    await child.dispose();
    expect(scans).toBe(1);
    expect(reported).toEqual([]);
  });
});
