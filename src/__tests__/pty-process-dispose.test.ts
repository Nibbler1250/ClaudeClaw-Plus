/**
 * `PtyProcess.dispose()` proves the exit from the OS (#562 round 6 R2g, round 7 Fix 1).
 *
 * `bun-pty`'s spawn is replaced (through the `_ptySpawn` option, NOT `mock.module`, which is
 * process-wide and leaks into every later file of a single-process `bun test src`) by a child
 * that behaves like bun-pty 0.4.9: the FIRST `kill()` fires
 * the exit event synchronously whatever the signal, and later calls do nothing. The OS is a
 * stand-in too (`_signalPid`), so the escalation order and the unconfirmed case are
 * deterministic. The real library and a real stubborn child are in
 * `pty-process-dispose-real.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { PtyExitUnconfirmedError, spawnPty } from "../runner/pty-process";
import { withPlatformAsync } from "../runner/pty-test-platform";

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

const fakePtySpawn = (): FakeChild => {
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
};

interface FakeOs {
  alive: boolean;
  /** SIGKILL does not take it (a process stuck in uninterruptible sleep). */
  immune: boolean;
  log: string[];
  /** Birth identity the OS reports for the pid; `null` = unreadable. Change it = pid reused. */
  identity: string | null;
  signalPid: (pid: number, sig: NodeJS.Signals | 0) => void;
}

function makeOs(): FakeOs {
  const os: FakeOs = {
    alive: true,
    immune: false,
    identity: "boot-1",
    log: [],
    signalPid(pid, sig) {
      os.log.push(`${pid}:${sig}`);
      if (sig === 0) {
        if (!os.alive) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return;
      }
      // SIGKILL to the leader or to its group (-pid) takes it, unless it is immune.
      if (sig === "SIGKILL" && !os.immune) os.alive = false;
    },
  };
  return os;
}

async function spawnWith(
  os: FakeOs,
  extra: {
    _exitGraceMs?: number;
    _exitCapMs?: number;
    _readPidIdentity?: (pid: number) => string | null;
  } = {},
) {
  return spawnPty({
    sessionId: "",
    cwd: "/tmp",
    security: { level: "unrestricted", allowedTools: [], disallowedTools: [] },
    env: {},
    agentName: "test",
    _skipReadySettle: true,
    _skipClaudeArgs: true,
    transcriptPath: "/tmp/never-written.jsonl",
    _ptySpawn: fakePtySpawn as never,
    _signalPid: os.signalPid,
    _readPidIdentity: () => os.identity,
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
    // Fault (site: `_retire`, drop the OS confirmation): dispose() resolves as soon as
    // bun-pty's synthetic exit event has fired. Predicted result: `settled` is already true
    // at the check below, and the OS still shows the child.
    // The state is read when SIGKILL reaches the OS, not after a fixed sleep: a 60 ms timer
    // that fired late under CPU load landed past the 150 ms grace, after SIGKILL had already
    // taken the child (#613).
    const os = makeOs();
    let settled = false;
    let atKill: { exitReported: boolean; osAlive: boolean; settled: boolean } | null = null;
    let procRef: { isAlive(): boolean } | null = null;
    let disposedAt = 0;
    let killAfterMs = -1;
    const signalPid = os.signalPid;
    os.signalPid = (pid, sig) => {
      if (sig === "SIGKILL" && atKill === null && procRef) {
        atKill = { exitReported: !procRef.isAlive(), osAlive: os.alive, settled };
        killAfterMs = performance.now() - disposedAt;
      }
      signalPid(pid, sig);
    };
    const proc = await spawnWith(os);
    procRef = proc;
    const fake = child as FakeChild | null;
    if (!fake) throw new Error("fake bun-pty was not used");

    disposedAt = performance.now();
    const disposing = proc.dispose().then(() => {
      settled = true;
    });
    await disposing;

    // When SIGKILL went out, bun-pty had already reported the exit, the OS still had the
    // process, and dispose() was still pending.
    expect(atKill).toEqual({ exitReported: true, osAlive: true, settled: false });
    // The group got SIGTERM first and SIGKILL only once the grace was out. A timer never fires
    // early, so this lower bound cannot flake under load; the margin covers clock rounding.
    const term = os.log.findIndex((e) => e.endsWith(":SIGTERM"));
    expect(term).toBeGreaterThanOrEqual(0);
    expect(term).toBeLessThan(os.log.findIndex((e) => e.endsWith(":SIGKILL")));
    expect(killAfterMs).toBeGreaterThanOrEqual(140);

    expect(os.alive).toBe(false);
    expect(fake.kills).toEqual(["SIGTERM"]);
  });

  test("SIGKILL goes straight to the OS, to the group (which already reaches the leader)", async () => {
    // Fault (site: `retireProcessGroup`, send SIGKILL through bun-pty instead of the OS): the
    // fake bun-pty's second kill() is a no-op, so the OS never sees a SIGKILL. Predicted
    // result: no `SIGKILL` in the OS log and dispose() rejects at the cap.
    const os = makeOs();
    const proc = await spawnWith(os);

    await proc.dispose();

    const kills = os.log.filter((e) => e.endsWith(":SIGKILL"));
    // The group signal reaches the leader, a member of its own group, so no second, bare-pid
    // signal goes out: it would only be one more chance to hit a reused pid.
    expect(kills).toEqual([`-${proc.pid}:SIGKILL`]);
  });

  test("a process that survives SIGKILL makes dispose() reject, and a later confirmation succeeds", async () => {
    // Fault (site: `_confirmGone`, return instead of throwing at the cap): dispose()
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

  test("a pid the OS has handed to another process counts as exited and is never signalled", async () => {
    // Fault (site: `_pidState`, skip the identity comparison): existence alone says "still
    // there", so the stranger is waited on and then SIGKILLed. Predicted result: a
    // `-pid:SIGKILL` entry in the OS log and `os.alive` false.
    const os = makeOs();
    const proc = await spawnWith(os);
    os.identity = "boot-2"; // the original exited, the pid was reused

    await proc.dispose();

    expect(os.log.filter((e) => e.endsWith(":SIGKILL"))).toEqual([]);
    expect(os.alive).toBe(true); // the stranger is untouched
    expect(child?.kills).toEqual([]);
  });

  test("a pid reused one tick after the child was born (a raw Linux start time one higher) is never signalled", async () => {
    // The identity is compared exactly as read: a window of one tick (10 ms) or one second would
    // call the stranger the child.
    const os = makeOs();
    os.identity = "500000";
    const proc = await spawnWith(os);
    os.identity = "500001";

    await proc.dispose();

    expect(os.log.filter((e) => e.endsWith(":SIGKILL"))).toEqual([]);
    expect(os.alive).toBe(true);
    expect(child?.kills).toEqual([]);
  });

  test("the identity is read again immediately before each SIGKILL: a pid reused after the last wait check is left alone", async () => {
    // Every earlier look says "same". The pid is handed over after the wait's last check and
    // before the signal, so only a read made right before the signal sees the stranger.
    // The hand-over is placed by order, not by the clock. Every identity read follows its own
    // existence probe (`<pid>:0`); inside a wait check that probe follows the check's leader
    // probe (`<pid>:0`), while a read made after a completed check follows its group probe
    // (`-<pid>:0`). After SIGTERM, that read is the one before the next signal. A wall-clock
    // cut-off raced the retirement's own clock: a wait could end on a check that read no
    // identity, and the pre-SIGKILL read was then the one that crossed the cut-off, still "same".
    // Fault (site: `GroupTarget.sendGroup`, drop the identity read before kill()): no read sees
    // the stranger. Predicted result: `flipped` false and a `-pid:SIGKILL` entry.
    const os = makeOs();
    let flipped = false;
    let flipAt = -1;
    let waitChecksAfterTerm = 0;
    os.identity = null; // the reader below answers instead
    const proc = await spawnWith(os, {
      _exitGraceMs: 200,
      _exitCapMs: 800,
      _readPidIdentity: (pid) => {
        if (flipped) return "boot-2";
        if (!os.log.some((e) => e.endsWith(":SIGTERM"))) return "boot-1";
        if (os.log.at(-2) !== `-${pid}:0`) {
          waitChecksAfterTerm++; // a read inside a wait check: still "same"
          return "boot-1";
        }
        flipped = true; // the read after the wait's last check: the pid is a stranger's now
        flipAt = os.log.length;
        return "boot-2";
      },
    });

    await proc.dispose();

    expect(waitChecksAfterTerm).toBeGreaterThan(0);
    expect(flipped).toBe(true);
    // No wait check (its group probe, `-pid:0`) came after the read that saw the stranger: it was
    // the last read before the signal, not one made earlier in the wait and kept until kill().
    expect(os.log.slice(flipAt).filter((e) => e.startsWith("-"))).toEqual([]);
    expect(os.log.filter((e) => e.endsWith(":SIGKILL"))).toEqual([]);
    expect(os.alive).toBe(true); // the stranger is untouched
  });

  test("a later confirmation whose identity cannot be read sends no signal and stays unconfirmed", async () => {
    // Fault (site: `GroupTarget.sendGroup`, treat "unknown" as signalable on any retirement): the later
    // confirmation SIGKILLs a pid it cannot vouch for. Predicted result: a second pair of
    // SIGKILL entries and `os.alive` false.
    const os = makeOs();
    os.immune = true;
    const proc = await spawnWith(os);
    await expect(proc.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
    const killsAfterFirst = os.log.filter((e) => e.endsWith(":SIGKILL")).length;
    expect(killsAfterFirst).toBe(1); // initial window, identity matched: the group signal

    os.identity = null; // `ps` / `/proc` unreadable now
    os.immune = false;
    await expect(proc.confirmExit?.()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);

    expect(os.log.filter((e) => e.endsWith(":SIGKILL")).length).toBe(killsAfterFirst);
    expect(os.alive).toBe(true);
  });

  test("Linux: with no identity recorded at spawn the initial retirement may signal, a later one may not", async () => {
    // Fault (site: `GroupTarget.sendGroup`, drop the `initial` clause): the initial retirement refuses
    // to signal and the process outlives it. Predicted result: dispose() rejects with
    // no SIGKILL logged.
    const os = makeOs();
    os.immune = true;
    const proc = await spawnWith(os, { _readPidIdentity: () => null });
    await expect(withPlatformAsync("linux", () => proc.dispose())).rejects.toBeInstanceOf(
      PtyExitUnconfirmedError,
    );
    const killsAfterFirst = os.log.filter((e) => e.endsWith(":SIGKILL")).length;
    expect(killsAfterFirst).toBe(1);

    os.immune = false;
    await expect(
      withPlatformAsync("linux", async () => proc.confirmExit?.()),
    ).rejects.toBeInstanceOf(PtyExitUnconfirmedError);

    expect(os.log.filter((e) => e.endsWith(":SIGKILL")).length).toBe(killsAfterFirst);
  });

  test("macOS: with no identity recorded at spawn nothing is signalled, the initial retirement included (#581 decision 2, review H1)", async () => {
    const os = makeOs();
    os.immune = true;
    const proc = await spawnWith(os, { _readPidIdentity: () => null });
    await expect(withPlatformAsync("darwin", () => proc.dispose())).rejects.toBeInstanceOf(
      PtyExitUnconfirmedError,
    );
    // Fault (site: `allowUnrecordedInitial` true on every platform): one SIGKILL is logged.
    expect(os.log.filter((e) => e.endsWith(":SIGTERM") || e.endsWith(":SIGKILL"))).toEqual([]);
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
