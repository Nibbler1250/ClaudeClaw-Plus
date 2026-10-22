/**
 * `PtyProcess.dispose()` proves the exit from the OS (#562 round 6 R2g, round 7 Fix 1).
 *
 * `bun-pty` is replaced by a child that behaves like bun-pty 0.4.9: the FIRST `kill()` fires
 * the exit event synchronously whatever the signal, and later calls do nothing. The OS is a
 * stand-in too (`_signalPid`), so the escalation order and the unconfirmed case are
 * deterministic. The real library and a real stubborn child are in
 * `pty-process-dispose-real.test.ts`.
 *
 * Its own file because `mock.module` is process-wide for the file that installs it.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

interface FakeChild {
  pid: number;
  kills: string[];
  exitCbs: Array<(info: { exitCode: number; signal?: number | string }) => void>;
  onData: (cb: (d: string) => void) => { dispose(): void };
  onExit: (cb: (info: { exitCode: number; signal?: number | string }) => void) => {
    dispose(): void;
  };
  write: (d: string) => void;
  resize: () => void;
  kill: (sig?: string) => void;
}

let child: FakeChild | null = null;
let fakePid = 424242;

mock.module("bun-pty", () => ({
  spawn: (): FakeChild => {
    let closing = false;
    const c: FakeChild = {
      pid: fakePid,
      kills: [],
      exitCbs: [],
      onData: () => ({ dispose() {} }),
      onExit: (cb) => {
        c.exitCbs.push(cb);
        return { dispose() {} };
      },
      write() {},
      resize() {},
      kill(sig = "SIGTERM") {
        // bun-pty 0.4.9: the signal is ignored, the exit event fires at once, and a second
        // kill() is a no-op.
        c.kills.push(sig);
        if (closing) return;
        closing = true;
        for (const cb of c.exitCbs) cb({ exitCode: 0, signal: sig });
      },
    };
    child = c;
    return c;
  },
}));

const { spawnPty, PtyExitUnconfirmedError } = await import("../runner/pty-process");

interface FakeOs {
  alive: boolean;
  /** SIGKILL does not take it (a process stuck in uninterruptible sleep). */
  immune: boolean;
  log: string[];
  signalPid: (pid: number, sig: NodeJS.Signals | 0) => void;
}

function makeOs(): FakeOs {
  const os: FakeOs = {
    alive: true,
    immune: false,
    log: [],
    signalPid(pid, sig) {
      os.log.push(`${pid}:${sig}`);
      if (sig === 0) {
        if (!os.alive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return;
      }
      if (sig === "SIGKILL" && pid > 0 && !os.immune) os.alive = false;
    },
  };
  return os;
}

async function spawnWith(os: FakeOs, extra: { _exitGraceMs?: number; _exitCapMs?: number } = {}) {
  return spawnPty({
    sessionId: "",
    cwd: "/tmp",
    security: { level: "unrestricted", allowedTools: [], disallowedTools: [] },
    env: {},
    agentName: "test",
    _skipReadySettle: true,
    _skipClaudeArgs: true,
    transcriptPath: "/tmp/never-written.jsonl",
    _signalPid: os.signalPid,
    _exitGraceMs: 150,
    _exitCapMs: 600,
    ...extra,
  });
}

afterEach(() => {
  child = null;
  fakePid = 424242;
});

describe("PtyProcess.dispose — the OS decides, not bun-pty's exit event", () => {
  test("a child that outlives SIGTERM keeps dispose pending until SIGKILL has taken it", async () => {
    // Fault (site: `_retire`, drop the pid confirmation): dispose() resolves as soon as
    // bun-pty's synthetic exit event has fired. Predicted result: `settled` is already true
    // at the check below, and the OS still shows the child.
    const os = makeOs();
    const proc = await spawnWith(os);
    const fake = child as FakeChild | null;
    if (!fake) throw new Error("fake bun-pty was not used");

    let settled = false;
    const disposing = proc.dispose().then(() => {
      settled = true;
    });
    await new Promise<void>((r) => setTimeout(r, 60));

    // bun-pty already reported the exit, and the OS still has the process.
    expect(proc.isAlive()).toBe(false);
    expect(os.alive).toBe(true);
    expect(settled).toBe(false);

    await disposing;

    expect(os.alive).toBe(false);
    expect(fake.kills).toEqual(["SIGTERM"]);
  });

  test("SIGKILL goes straight to the OS, to the group first and then the leader", async () => {
    // Fault (site: `_confirmGoneByPid`, send SIGKILL through bun-pty instead of the OS): the
    // fake bun-pty's second kill() is a no-op, so the OS never sees a SIGKILL. Predicted
    // result: no `SIGKILL` in the OS log and dispose() rejects at the cap.
    const os = makeOs();
    const proc = await spawnWith(os);

    await proc.dispose();

    const kills = os.log.filter((e) => e.endsWith(":SIGKILL"));
    expect(kills).toEqual([`-${proc.pid}:SIGKILL`, `${proc.pid}:SIGKILL`]);
  });

  test("a process that survives SIGKILL makes dispose() reject, and a later confirmation succeeds", async () => {
    // Fault (site: `_confirmGoneByPid`, return instead of throwing at the cap): dispose()
    // resolves with the child still alive. Predicted result: the rejects assertion fails.
    const os = makeOs();
    os.immune = true;
    const proc = await spawnWith(os);

    await expect(proc.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
    expect(os.alive).toBe(true);

    // The next call is a fresh attempt, not the cached rejection.
    os.immune = false;
    await proc.confirmExit?.();
    expect(os.alive).toBe(false);
  });

  test("a pid that cannot be a real child is never signalled (no kill(-1), no kill(0))", async () => {
    for (const bad of [-1, 0, 1]) {
      fakePid = bad;
      const os = makeOs();
      const proc = await spawnWith(os);
      await proc.dispose();
      expect(os.log).toEqual([]);
    }
  });
});
