/**
 * #581 cp3, staged enforcement of the process-GROUP exit confirmation (Terry, 2026-10-23).
 *
 * Termination is common; what an unconfirmed GROUP means depends on the route:
 *   untrusted one-shot  always enforce (the setting cannot weaken it)
 *   trusted PTY         `pty.groupConfirm`: "observe" (default) logs and counts, "enforce" rejects
 *   unconfirmed LEADER  rejects in every mode on every route
 * A rejected `dispose()` is what the supervisor quarantines on, so "no quarantine" is a
 * `dispose()` that resolves.
 *
 * The native PTY and the OS are both stand-ins (`_ptySpawn`, `_signalPid`): nothing here can
 * signal a real pid, negative or not.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  __resetGroupUnconfirmedForTests,
  groupConfirmEnforced,
  groupUnconfirmedObservedCount,
} from "../runner/pty-group-confirm";
import {
  PtyExitUnconfirmedError,
  type PtyProcess,
  type PtyProcessOptions,
  spawnPty,
} from "../runner/pty-process";

type ExitCb = (info: { exitCode: number; signal?: number | string }) => void;

interface FakeNative {
  pid: number;
  kills: string[];
  /** The native exit event, as bun-pty fires it: also synchronously from `kill()`. */
  fireExit: () => void;
}

let native: FakeNative | null = null;

function fakePtySpawn(): never {
  const exitCbs: ExitCb[] = [];
  let closing = false;
  const fire = (): void => {
    for (const cb of exitCbs) cb({ exitCode: 0 });
  };
  const c = {
    pid: 424242,
    kills: [] as string[],
    fireExit: fire,
    onData: () => ({ dispose() {} }),
    onExit: (cb: ExitCb) => {
      exitCbs.push(cb);
      return { dispose() {} };
    },
    write() {},
    resize() {},
    kill(sig = "SIGTERM") {
      c.kills.push(sig);
      if (closing) return;
      closing = true;
      fire();
    },
  };
  native = c;
  return c as never;
}

interface FakeOs {
  leader: boolean;
  members: number;
  immuneLeader: boolean;
  immuneMembers: boolean;
  log: string[];
  signalPid: (pid: number, sig: NodeJS.Signals | 0) => void;
}

function makeOs(init: Partial<FakeOs> = {}): FakeOs {
  const os: FakeOs = {
    leader: true,
    members: 0,
    immuneLeader: false,
    immuneMembers: false,
    log: [],
    signalPid(pid, sig) {
      const esrch = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      if (sig === 0) {
        if (pid < 0 ? !os.leader && os.members === 0 : !os.leader) throw esrch;
        return;
      }
      os.log.push(`${pid}:${sig}`);
      if (sig !== "SIGKILL") return;
      if (!os.immuneLeader) os.leader = false;
      if (pid < 0 && !os.immuneMembers) os.members = 0;
    },
    ...init,
  };
  return os;
}

function spawnOver(os: FakeOs, extra: Partial<PtyProcessOptions> = {}): Promise<PtyProcess> {
  return spawnPty({
    sessionId: "",
    cwd: "/tmp",
    security: { level: "unrestricted", allowedTools: [], disallowedTools: [] },
    env: {},
    agentName: "agent:alpha",
    sessionKey: "agent:alpha",
    _skipReadySettle: true,
    _skipClaudeArgs: true,
    transcriptPath: "/tmp/never-written.jsonl",
    _ptySpawn: fakePtySpawn as never,
    _signalPid: os.signalPid,
    _readPidIdentity: () => "boot-1",
    _liveMembers: () => (os.leader ? 1 : 0) + os.members,
    _describeGroup: () => ({ count: os.members, comm: ["mcp-server", "git"] }),
    _exitGraceMs: 80,
    _exitCapMs: 300,
    ...extra,
  });
}

let warn: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
const warned = (): string => warn.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");

beforeEach(() => {
  __resetGroupUnconfirmedForTests();
  warn = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  native = null;
});

describe("the one predicate", () => {
  test("untrusted always enforces; trusted enforces only on 'enforce'", () => {
    expect(groupConfirmEnforced(true, "observe")).toBe(true);
    expect(groupConfirmEnforced(true, "enforce")).toBe(true);
    expect(groupConfirmEnforced(false, "observe")).toBe(false);
    expect(groupConfirmEnforced(false, "enforce")).toBe(true);
  });
});

describe("trusted PTY: leader gone, a group member survives SIGKILL", () => {
  test("observe (the default): no quarantine, one log line, one count", async () => {
    // Fault (site: `_mapGroupOutcome`, throw on any group outcome): dispose() rejects, which the
    // supervisor quarantines on. Predicted result: the resolves assertion fails.
    const os = makeOs({ members: 1, immuneMembers: true });
    const proc = await spawnOver(os);
    await proc.dispose(); // resolves: not rejected, so the supervisor records no quarantine
    expect(groupUnconfirmedObservedCount()).toBe(1);
    const line = warned()
      .split("\n")
      .filter((l) => l.startsWith("[pty] group-unconfirmed"));
    expect(line).toHaveLength(1);
    expect(line[0]).toBe(
      "[pty] group-unconfirmed mode=observe key=agent:alpha reason=survivor survivors=1 comm=mcp-server,git",
    );
    // The leader was killed and the group got its SIGKILL: the survivor is unkillable, not ignored.
    expect(os.log).toContain(`-${proc.pid}:SIGKILL`);
  });

  test("enforce: dispose rejects with the exit-unconfirmed error and nothing is counted", async () => {
    const os = makeOs({ members: 1, immuneMembers: true });
    const proc = await spawnOver(os, { _groupConfirm: "enforce" });
    await expect(proc.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
    expect(groupUnconfirmedObservedCount()).toBe(0);
  });

  test("the log line carries no argv and no screen text: names only", async () => {
    const os = makeOs({ members: 1, immuneMembers: true });
    const proc = await spawnOver(os, {
      _describeGroup: () => ({ count: 1, comm: ["/usr/bin/node --token=abc\nsecret"] }),
    });
    await proc.dispose();
    const line = warned()
      .split("\n")
      .find((l) => l.startsWith("[pty] group-unconfirmed")) as string;
    expect(line).not.toContain("\n");
    expect(line).not.toContain("abc\nsecret");
    expect(line).not.toContain(" --token");
  });
});

describe("an unconfirmed LEADER is never observed away", () => {
  test("trusted, observe: an immune leader rejects", async () => {
    // Fault (site: `_mapGroupOutcome`, let the leader case fall into the observe branch):
    // dispose() resolves with a leader the OS still shows. Predicted result: rejects fails.
    const os = makeOs({ immuneLeader: true });
    const proc = await spawnOver(os, { _groupConfirm: "observe" });
    await expect(proc.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
    expect(groupUnconfirmedObservedCount()).toBe(0);
  });

  test("trusted, enforce: the same", async () => {
    const os = makeOs({ immuneLeader: true });
    const proc = await spawnOver(os, { _groupConfirm: "enforce" });
    await expect(proc.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
  });
});

describe("untrusted one-shot: always enforce", () => {
  for (const mode of ["observe", "enforce"] as const) {
    test(`a survivor holds and rejects with the setting at '${mode}', and the hook is told`, async () => {
      // Fault (site: `_mapGroupOutcome`, pass the configured mode instead of `untrusted ||`):
      // an untrusted survivor is observed. Predicted result: resolves, hook not called.
      const os = makeOs({ members: 1, immuneMembers: true });
      const causes: string[] = [];
      const proc = await spawnOver(os, {
        isolation: "untrusted",
        _groupConfirm: mode,
        onGroupSurvived: (_pid, _start, cause) => causes.push(cause),
      });
      await expect(proc.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
      expect(causes).toEqual(["group"]);
      expect(groupUnconfirmedObservedCount()).toBe(0);
    });
  }

  test("a hook that throws cannot skip the rejection", async () => {
    const os = makeOs({ members: 1, immuneMembers: true });
    const proc = await spawnOver(os, {
      isolation: "untrusted",
      onGroupSurvived: () => {
        throw new Error("could not record");
      },
    });
    await expect(proc.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
  });
});

describe("natural leader exit before dispose", () => {
  test("the group it left behind is still TERMed, KILLed and confirmed", async () => {
    const os = makeOs({ leader: false, members: 2 });
    const proc = await spawnOver(os);
    // The leader went by itself, with members still in its group: bun-pty's exit event.
    (native as FakeNative).fireExit();
    expect(proc.isAlive()).toBe(false);
    await proc.dispose();
    expect(os.members).toBe(0);
    expect(os.log).toEqual([`-${proc.pid}:SIGTERM`, `-${proc.pid}:SIGKILL`]);
    expect(groupUnconfirmedObservedCount()).toBe(0);
  });

  test("exit-time evidence goes stale: a late dispose signals nothing on a group it cannot vouch for", async () => {
    // Fault (site: `_confirmGone`, drop the freshness bound): the late dispose KILLs `-pid`, which
    // by now may be a stranger's. Predicted result: `-pid:SIGKILL` in the log.
    const os = makeOs({ leader: false, members: 2, immuneMembers: true });
    const proc = await spawnOver(os, { _groupContinuityMaxAgeMs: 20 });
    (native as FakeNative).fireExit(); // the group was alive when the leader went
    await new Promise((r) => setTimeout(r, 60));
    await proc.dispose();
    expect(os.log).toEqual([]);
    expect(groupUnconfirmedObservedCount()).toBe(1); // reported (reason unknown-identity), not signalled
  });

  test("within the window the same dispose does signal the group it saw", async () => {
    const os = makeOs({ leader: false, members: 2 });
    const proc = await spawnOver(os, { _groupContinuityMaxAgeMs: 5000 });
    (native as FakeNative).fireExit();
    await proc.dispose();
    expect(os.log).toEqual([`-${proc.pid}:SIGTERM`, `-${proc.pid}:SIGKILL`]);
  });

  test("a group seen while a signal was withheld does not become continuity for the retry", async () => {
    // Fault (site: `retireProcessGroup`, continuityHeld = "the group was seen"): the unvouched
    // group is renewed as ours and the retry KILLs it. Predicted result: `-pid:SIGKILL` in the log.
    const os = makeOs({ leader: false, members: 0 });
    const proc = await spawnOver(os, { _groupConfirm: "enforce" });
    (native as FakeNative).fireExit(); // no group behind the leader at its exit
    os.members = 3; // a stranger's group appears on the pgid
    await expect(proc.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
    await expect(proc.confirmExit?.()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
    expect(os.log).toEqual([]);
    expect(os.members).toBe(3); // untouched
  });

  test("an exit that left no group behind signals nothing, even if something answers on the pgid later", async () => {
    // The exit event finds no group (continuity not established); a stranger's group then
    // appears on that pgid. Without evidence it is ours, nothing is sent.
    const os = makeOs({ leader: false, members: 0 });
    const proc = await spawnOver(os);
    (native as FakeNative).fireExit();
    os.members = 3;
    os.immuneMembers = true;
    await proc.dispose();
    expect(os.log).toEqual([]);
    expect(groupUnconfirmedObservedCount()).toBe(1); // observed: unconfirmed, untouched
  });
});

describe("joined, retryable confirmExit after a native exit event", () => {
  test("the exit event is not proof: dispose rejects while the OS shows the leader, and confirmExit later succeeds", async () => {
    // Fault (site: `_confirmGone`, resolve on the exit event): dispose() resolves at once.
    const os = makeOs({ immuneLeader: true });
    const proc = await spawnOver(os);
    (native as FakeNative).fireExit(); // a fake native onExit
    expect(proc.isAlive()).toBe(false);
    await expect(proc.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);

    os.immuneLeader = false;
    await proc.confirmExit?.(); // a fresh attempt, not the cached rejection
    expect(os.leader).toBe(false);
  });

  test("concurrent dispose and confirmExit join one retirement", async () => {
    const os = makeOs({ members: 1 });
    const proc = await spawnOver(os);
    const a = proc.dispose();
    const b = proc.confirmExit?.() as Promise<void>;
    expect(b).toBe(a);
    await a;
    // Settled OK: later calls return at once, signalling nothing more.
    const logged = os.log.length;
    await proc.confirmExit?.();
    expect(os.log.length).toBe(logged);
  });
});

describe("one deadline", () => {
  test("the escape scan gets what is left of the cap, not a budget of its own", async () => {
    const os = makeOs({ members: 1, immuneMembers: true, immuneLeader: true });
    const seen: number[] = [];
    const started = Date.now();
    const proc = await spawnOver(os, {
      isolation: "untrusted",
      _exitGraceMs: 80,
      _exitCapMs: 300,
      reapEscapees: async (leader) => {
        seen.push(leader.remainingMs);
        return [];
      },
    });
    await expect(proc.dispose()).rejects.toBeInstanceOf(PtyExitUnconfirmedError);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeLessThanOrEqual(300);
    // The retirement spent the cap, not the cap plus a scan budget.
    expect(Date.now() - started).toBeLessThan(300 + 250);
  });
});
