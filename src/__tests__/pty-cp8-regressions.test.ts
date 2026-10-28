/**
 * #581 cp8: regression tests for Codex's cross-family review of 8917ca95 (4 HIGH, 3 MEDIUM, 2 LOW).
 *
 * Each test is black-box: it uses only seams and APIs that exist at 8917ca95 and at the fix, so the
 * same file runs unchanged against `git archive 8917ca95` (RED) and the fixed head (GREEN). A seam
 * the old code does not know (`_readPgid`, a `deadlineAt` option) is passed anyway and ignored
 * there, which is the point. Nothing here can signal a real pid: the OS is a stand-in throughout.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyAgentProcess, type PtyHandle } from "../bus/session-agent-process";
import { SessionManager } from "../bus/session-manager";
import { discordStatusText } from "../commands/discord";
import { telegramStatusText } from "../commands/telegram";
import {
  markGroupSurvivor,
  resetGroupSurvivorsForTests,
  retrySurvivingGroups,
} from "../oneshot/pty-cleanup";
import { terminateEscapees } from "../runner/pty-escape-scan";
import {
  __resetGroupUnconfirmedForTests,
  recordGroupUnconfirmedObserved,
} from "../runner/pty-group-confirm";
import { PtyExitUnconfirmedError, type PtyProcessOptions, spawnPty } from "../runner/pty-process";
import {
  __resetQuarantineForTests,
  assertSessionSpawnable,
  quarantineSnapshot,
} from "../runner/pty-quarantine";

const esrch = (): Error => Object.assign(new Error("ESRCH"), { code: "ESRCH" });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type ExitCb = (info: { exitCode: number; signal?: number | string }) => void;

/** bun-pty 0.4.9: the FIRST kill() fires the exit event synchronously, whatever the signal. */
function fakeNative(pid = 424242) {
  const exits: ExitCb[] = [];
  const data: Array<(chunk: string) => void> = [];
  let closing = false;
  const fire = (): void => {
    for (const cb of [...exits]) cb({ exitCode: 0 });
  };
  const handle = {
    pid,
    kills: [] as string[],
    exits,
    data,
    fire,
    onExit: (cb: ExitCb) => {
      exits.push(cb);
      return { dispose() {} };
    },
    onData: (cb: (chunk: string) => void) => {
      data.push(cb);
      return { dispose() {} };
    },
    write(_s: string) {},
    resize() {},
    kill(sig = "SIGTERM") {
      handle.kills.push(sig);
      if (closing) return;
      closing = true;
      fire();
    },
  };
  return handle;
}

const security = { level: "unrestricted", allowedTools: [], disallowedTools: [] } as const;

function spawnOver(
  handle: ReturnType<typeof fakeNative>,
  extra: Partial<PtyProcessOptions> & Record<string, unknown> = {},
) {
  return spawnPty({
    sessionId: "",
    cwd: "/tmp",
    env: {},
    security,
    _ptySpawn: (() => handle) as never,
    _skipReadySettle: true,
    _skipClaudeArgs: true,
    transcriptPath: "/tmp/cp8-never-written.jsonl",
    _readPidIdentity: () => "id",
    ...extra,
  } as PtyProcessOptions);
}

let warn: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  __resetQuarantineForTests();
  __resetGroupUnconfirmedForTests();
  resetGroupSurvivorsForTests();
  warn = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  __resetQuarantineForTests();
  resetGroupSurvivorsForTests();
});

describe("H1: survivor retries are the common retirement, with no authority of their own", () => {
  test("a recorded leader birth time does not authorise a group signal once the leader is gone", async () => {
    // The original group died between retries and its number was reused; the leader of the new
    // group exited and a child of it remains. Codex logged TERM then KILL to -424242 here.
    const sent: Array<[number, unknown]> = [];
    const kill = spyOn(process, "kill").mockImplementation(((pid: number, sig?: unknown) => {
      if (sig === 0 || sig === undefined) {
        if (pid > 0) throw esrch(); // the leader is gone
        return true; // a group still answers on the number
      }
      sent.push([pid, sig]);
      return true;
    }) as never);
    try {
      markGroupSurvivor("/tmp/cp8-h1-root", 424242, { startMs: 1_700_000_000_000, cwds: [] });
      // `capMs` is read by the fix only; 8917ca95 ignores it and runs its own 2 s + 2 s loops.
      await (retrySurvivingGroups as (d: object) => Promise<number>)({
        reap: async () => [],
        capMs: 150,
      });
    } finally {
      kill.mockRestore();
    }
    expect(sent).toEqual([]);
  }, 15_000);
});

describe("H2: nothing renews group authority from a flag or the time since the last look", () => {
  test("a retry after the original survivors are gone and the pgid was reused signals nothing", async () => {
    const handle = fakeNative();
    let leader = true;
    let group = true;
    let foreign = false;
    const calls: unknown[] = [];
    const proc = await spawnOver(handle, {
      _groupConfirm: "enforce",
      _signalPid: (pid: number, s: unknown) => {
        if (s === 0) {
          if (pid > 0 ? !leader : !group) throw esrch();
          return;
        }
        calls.push({ pid, s, foreign });
        if (s === "SIGKILL") leader = false;
      },
      _liveMembers: () => 1,
      _describeGroup: () => ({ count: 1, comm: ["member"] }),
      _exitGraceMs: 1,
      _exitCapMs: 30,
    });
    await expect(proc.dispose()).rejects.toThrow();
    group = false; // the original group goes away between the calls, nobody looking
    foreign = true;
    group = true; // its number is reused; the new leader exited; a foreign child remains
    calls.length = 0;
    await expect(proc.confirmExit?.()).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("H3: bus retirement owns the session until the OS has spoken", () => {
  /** A PTY handle that is a real `PtyAgentProcess` over a stand-in OS whose leader never goes. */
  function stuckProc() {
    const handle = fakeNative();
    let quitting = false;
    handle.write = (s: string) => {
      if (s === "/quit") quitting = true;
      if (s === "\r" && quitting) handle.fire(); // /quit: the native exit event fires
    };
    const proc = new PtyAgentProcess("bus-review", handle as unknown as PtyHandle, {
      bootDialogMaxMs: 1,
      retire: {
        readPidIdentity: () => "id",
        signalPid: () => {}, // every probe answers: the leader and its group are still there
        liveMembers: () => 1,
        exitCapMs: 150,
        exitGraceMs: 20,
      },
    });
    return { handle, proc };
  }

  async function managerWith(proc: PtyAgentProcess, sessionId: string) {
    const manager = new SessionManager({
      commandOverride: "/bin/cat",
      argsOverride: [],
      sessionCollisionDetectMs: 0,
    });
    (manager as unknown as { spawnPty: () => Promise<PtyAgentProcess> }).spawnPty = async () =>
      proc;
    await manager.spawnAgent(
      {
        id: "bus-review",
        cwd: "/tmp",
        session_id: sessionId,
        supervision: "pty-stdin",
        permission_mode: "bypassPermissions",
      },
      "cli",
    );
    return manager;
  }

  const spawnable = (sessionId: string): boolean => {
    try {
      assertSessionSpawnable({ sessionId });
      return true;
    } catch {
      return false;
    }
  };

  test("stop(): the session is not spawnable while the leader is unconfirmed", async () => {
    const { proc } = stuckProc();
    const manager = await managerWith(proc, "cp8-h3-stop");
    const stopped = manager.stop("bus-review");
    // Fenced from the synchronous step of stop(), before the graceful phase: nothing may start
    // beside a process that is on its way out. Went red (spawnable) at 8917ca95.
    expect(spawnable("cp8-h3-stop")).toBe(false);
    while (!proc._isExited()) await sleep(5);
    expect(spawnable("cp8-h3-stop")).toBe(false);
    await stopped;
    expect(spawnable("cp8-h3-stop")).toBe(false); // unconfirmed: quarantined, never lifted
  });

  test("a natural exit goes through the same confirmation, and the session stays fenced", async () => {
    const { handle, proc } = stuckProc();
    const manager = await managerWith(proc, "cp8-h3-natural");
    handle.fire(); // the child "exits" outside stop(), while the OS still shows its leader
    expect(manager.getAgent("bus-review")).toBeUndefined(); // the registry owner is gone ...
    // ... and the session is fenced from the same synchronous step.
    expect(spawnable("cp8-h3-natural")).toBe(false);
    await sleep(400);
    expect(spawnable("cp8-h3-natural")).toBe(false); // never confirmed: quarantined
    // The fence changed hands to a quarantine record in one step; a natural exit that never ran
    // the confirmation would leave a fence nobody ever lifts or converts.
    expect(quarantineSnapshot().map((q) => q.reason)).toEqual(["bus-exit-unconfirmed"]);
  });

  test("a natural exit the OS confirms lifts the fence", async () => {
    const handle = fakeNative();
    let leader = true;
    const proc = new PtyAgentProcess("bus-review", handle as unknown as PtyHandle, {
      bootDialogMaxMs: 1,
      retire: {
        readPidIdentity: () => "id",
        signalPid: (pid: number, sig: NodeJS.Signals | 0) => {
          if (sig === 0 && !leader) throw esrch();
        },
        liveMembers: () => (leader ? 1 : 0),
        exitCapMs: 300,
        exitGraceMs: 40,
      },
    });
    const manager = await managerWith(proc, "cp8-h3-natural-ok");
    leader = false; // the process really is gone
    handle.fire();
    expect(spawnable("cp8-h3-natural-ok")).toBe(false); // fenced until the OS has spoken ...
    await sleep(150);
    expect(spawnable("cp8-h3-natural-ok")).toBe(true); // ... and released by it
    expect(quarantineSnapshot()).toEqual([]);
    expect(manager.getAgent("bus-review")).toBeUndefined();
  });

  test("a late finaliser does not delete a replacement agent that took the id", async () => {
    const { proc: old } = stuckProc();
    const manager = await managerWith(old, "cp8-h3-old-session");
    const stopped = manager.stop("bus-review"); // retirement pending (its leader never goes)
    while (!old._isExited()) await sleep(5);
    // The id was released by the exit; a replacement is registered under it while the old
    // agent's finaliser is still to run.
    const { proc: replacement } = stuckProc();
    const agents = (manager as unknown as { agents: Map<string, unknown> }).agents;
    const record = {
      agent: { id: "bus-review", cwd: "/tmp", session_id: "cp8-h3-new-session" },
      origin: "cli",
      mode: "pty-stdin",
      proc: replacement,
      spawnedAt: Date.now(),
    };
    agents.set("bus-review", record);
    await stopped; // the old agent's finaliser runs now
    // Went red (undefined) at 8917ca95: the finaliser deleted whatever held the id.
    expect(manager.getAgent("bus-review")).toBe(replacement);
    expect(agents.get("bus-review")).toBe(record);
  });
});

describe("H3 positive control: the OS confirming the exit releases the session", () => {
  test("stop(): the graceful quit ends the leader, its group is retired, and the session is spawnable again", async () => {
    const handle = fakeNative();
    let leader = true;
    let members = 2;
    const log: string[] = [];
    let quitting = false;
    handle.write = (text: string) => {
      if (text === "/quit") quitting = true;
      if (text === "\r" && quitting) {
        leader = false; // the quit ends the leader; its members stay in the group
        handle.fire();
      }
    };
    const proc = new PtyAgentProcess("bus-review", handle as unknown as PtyHandle, {
      bootDialogMaxMs: 1,
      retire: {
        readPidIdentity: () => "id",
        readMembers: () => ({
          members: Array.from({ length: members }, (_, i) => ({
            pid: 9000 + i,
            identity: `m${i}`,
          })),
          complete: true,
        }),
        signalPid: (pid: number, sig: NodeJS.Signals | 0) => {
          if (sig === 0) {
            if (pid > 0 ? !leader : !leader && members === 0) throw esrch();
            return;
          }
          log.push(`${pid}:${String(sig)}`);
          if (sig === "SIGKILL" && pid < 0) members = 0;
        },
        liveMembers: () => (leader ? 1 : 0) + members,
        exitCapMs: 300,
        exitGraceMs: 40,
      },
    });
    const manager = new SessionManager({
      commandOverride: "/bin/cat",
      argsOverride: [],
      sessionCollisionDetectMs: 0,
    });
    (manager as unknown as { spawnPty: () => Promise<PtyAgentProcess> }).spawnPty = async () =>
      proc;
    await manager.spawnAgent(
      {
        id: "bus-review",
        cwd: "/tmp",
        session_id: "cp8-h3-confirmed",
        supervision: "pty-stdin",
        permission_mode: "bypassPermissions",
      },
      "cli",
    );
    await manager.stop("bus-review");
    expect(log).toEqual(["-424242:SIGTERM", "-424242:SIGKILL"]);
    expect(members).toBe(0);
    // Confirmed on the OS's word: the fence is lifted, nothing is quarantined.
    expect(() => assertSessionSpawnable({ sessionId: "cp8-h3-confirmed" })).not.toThrow();
  });
});

describe("H4: the bus native kill needs proof before it is made", () => {
  test("a recorded identity that is now another process's gets no native kill", async () => {
    const handle = fakeNative();
    let identity: string | null = "old";
    const signals: unknown[] = [];
    const proc = new PtyAgentProcess("review", handle as unknown as PtyHandle, {
      bootDialogMaxMs: 1,
      retire: {
        readPidIdentity: () => identity,
        signalPid: (p: number, s: NodeJS.Signals | 0) => {
          if (s !== 0) signals.push([p, s]);
        },
        liveMembers: () => 1,
        exitGraceMs: 0,
        exitCapMs: 0,
      },
    });
    identity = "foreign";
    await proc.retire();
    // Went red (["SIGTERM"]) at 8917ca95: `_kill()` ran before any identity was looked at.
    expect(handle.kills).toEqual([]);
    expect(signals).toEqual([]);
  });

  test("an unrecorded identity gets no native kill either", async () => {
    const handle = fakeNative();
    const proc = new PtyAgentProcess("review", handle as unknown as PtyHandle, {
      bootDialogMaxMs: 1,
      retire: {
        readPidIdentity: () => null,
        signalPid: () => {},
        liveMembers: () => 1,
        exitGraceMs: 0,
        exitCapMs: 0,
      },
    });
    await proc.retire().catch(() => {});
    expect(handle.kills).toEqual([]);
  });
});

describe("M2: one absolute deadline end to end", () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), "cp8-proc-"));
  });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  const ROOT = "/tmp/claudeclaw-oneshot-cfg-CP8";

  test("the escape scan is bounded by the deadline on the wall clock, not by the sleeps it asked for", async () => {
    const dir = join(proc, "5001");
    mkdirSync(dir);
    writeFileSync(join(dir, "environ"), `CLAUDE_CONFIG_DIR=${ROOT}\0`);
    writeFileSync(join(dir, "stat"), "5001 (x) S 1 5001 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100 0\n");
    const started = Date.now();
    // Every requested sleep costs four times as long (scheduler delay, a slow /proc).
    const left = await (terminateEscapees as (t: object, o: object) => Promise<number[]>)(
      { root: ROOT, cwds: [] },
      {
        procDir: proc,
        selfPid: 1,
        uid: undefined,
        signal: () => {},
        startMs: () => 1,
        sleep: async (ms: number) => sleep(ms * 4),
        pollMs: 20,
        // Grace budgets that EXCEED the deadline: a scan that honours only its own budgets
        // runs for over two seconds here, one that honours the deadline stops at about 150 ms.
        termGraceMs: 1000,
        killGraceMs: 1000,
        deadlineAt: started + 150, // read by the fix only
      },
    ).catch(() => [5001]);
    // Went red (about 800 ms) at 8917ca95: `waited += pollMs` counted the requests, not the time.
    expect(Date.now() - started).toBeLessThan(450);
    expect(left).toEqual([5001]); // unresolved stays reported, never silently cleared
  });

  test("nothing is signalled, scanned or described once the cap is spent", async () => {
    const handle = fakeNative();
    const log: string[] = [];
    let reaped = 0;
    let describedAfter = 0;
    const started = Date.now();
    const cap = 120;
    const p = await spawnOver(handle, {
      isolation: "untrusted",
      _signalPid: (pid: number, s: unknown) => {
        if (s === 0) return; // everything answers: leader and group are always there
        log.push(`${pid}:${String(s)}:${Date.now() - started >= cap ? "late" : "ok"}`);
      },
      _liveMembers: () => 1,
      _describeGroup: () => {
        if (Date.now() - started >= cap) describedAfter++;
        return { count: 1, comm: [] };
      },
      reapEscapees: async () => {
        reaped++;
        return [];
      },
      _exitGraceMs: 40,
      _exitCapMs: cap,
    });
    await expect(p.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
    // Went red at 8917ca95: the scan ran on a spent cap, and the description after it.
    expect(reaped).toBe(0);
    expect(describedAfter).toBe(0);
    expect(log.filter((l) => l.endsWith(":late"))).toEqual([]);
  });

  test("a cap of zero starts nothing: no signal, no scan", async () => {
    const handle = fakeNative();
    const log: string[] = [];
    let reaped = 0;
    const p = await spawnOver(handle, {
      isolation: "untrusted",
      _signalPid: (pid: number, s: unknown) => {
        if (s !== 0) log.push(`${pid}:${String(s)}`);
      },
      _liveMembers: () => 1,
      reapEscapees: async () => {
        reaped++;
        return [];
      },
      _exitGraceMs: 0,
      _exitCapMs: 0,
    });
    await expect(p.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
    expect(log).toEqual([]);
    expect(reaped).toBe(0);
  });
});

describe("M3: a disposal re-entered from the native exit callback joins the initiating one", () => {
  test("the callback's dispose() is the same promise", async () => {
    const handle = fakeNative();
    const p = await spawnOver(handle, {
      // The leader is there, with its recorded identity, until the native kill ends it: since
      // cp10 (H5) only a positive identity match allows the native kill this test re-enters by.
      _signalPid: () => {
        if (handle.kills.length > 0) throw esrch();
      },
      _liveMembers: () => 0,
      _exitGraceMs: 0,
      // Not 0: since cp9 (M2) a spent cap allows no native kill, and without one the exit
      // callback this test re-enters through never fires.
      _exitCapMs: 50,
    });
    let callback: Promise<void> | undefined;
    handle.exits.push(() => {
      callback = p.dispose();
    });
    const first = p.dispose();
    await first;
    await callback;
    // Went red (distinct promises) at 8917ca95: `_disposal` was stored after the native kill.
    expect(callback).toBe(first);
  });
});

describe("L1: a negative target needs an isolated group that is not the daemon's", () => {
  async function run(readPgid: (pid: number) => number | null): Promise<string[]> {
    const handle = fakeNative();
    const sent: string[] = [];
    const p = await spawnOver(handle, {
      _readPgid: readPgid,
      _signalPid: (pid: number, s: unknown) => {
        if (s === 0) {
          if (pid > 0 && sent.length > 0) throw esrch();
          return;
        }
        sent.push(`${pid}:${String(s)}`);
      },
      _liveMembers: () => undefined,
      _exitGraceMs: 10,
      _exitCapMs: 60,
    });
    await p.dispose().catch(() => {});
    return sent.filter((s) => s.startsWith("-"));
  }

  test("a child that shares another group is never signalled as -pid", async () => {
    expect(await run((pid) => (pid === 424242 ? 777 : pid))).toEqual([]);
  });

  test("a group id that cannot be read is never a target", async () => {
    expect(await run(() => null)).toEqual([]);
  });

  test("the daemon's own group is never a target, even when its id differs from the daemon pid", async () => {
    // The daemon's group is led by 424242 (the child's pid), and the child shares it.
    expect(await run(() => 424242)).toEqual([]);
  });
});

describe("L2: /status shows the observed-group counter without an active session", () => {
  const settings = { model: "m", security: { level: "strict" } };

  test("discord", () => {
    recordGroupUnconfirmedObserved({
      key: "agent:a",
      reason: "survivor",
      survivors: 1,
      comm: ["x"],
    });
    const text = discordStatusText(undefined, [], settings, [], 0);
    expect(text).toContain("PTY groups unconfirmed (observed): 1");
  });

  test("telegram", () => {
    recordGroupUnconfirmedObserved({
      key: "agent:a",
      reason: "survivor",
      survivors: 1,
      comm: ["x"],
    });
    const text = telegramStatusText(undefined, settings, [], 0);
    expect(text).toContain("PTY groups unconfirmed (observed): 1");
  });
});
