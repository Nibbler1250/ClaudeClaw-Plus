/**
 * #581 cp3: the bus PTY adapter retires through the common primitive (`retireProcessGroup`), and
 * the schema probe's teardown does too. The native PTY and the OS are stand-ins: nothing here can
 * signal a real pid, negative or not. The graceful `/quit` phase is `SessionManager.stop`'s and is
 * covered by session-manager.test.ts; this is what happens after it.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  __resetGroupUnconfirmedForTests,
  groupUnconfirmedObservedCount,
} from "../../runner/pty-group-confirm";
import { __resetQuarantineForTests, quarantineSnapshot } from "../../runner/pty-quarantine";
import {
  PtyAgentExitUnconfirmedError,
  PtyAgentProcess,
  type PtyHandle,
} from "../session-agent-process";
import { __confirmProbeGoneForTests } from "../schema-probe";

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

type ExitCb = (e: { exitCode: number; signal?: number | string }) => void;

/** bun-pty 0.4.9: the FIRST kill() fires the exit event synchronously, whatever the signal. */
function fakeHandle(pid: number): PtyHandle & { kills: string[]; fireExit: () => void } {
  const exitCbs: ExitCb[] = [];
  let closing = false;
  const fire = (): void => {
    for (const cb of exitCbs) cb({ exitCode: 0 });
  };
  return {
    pid,
    kills: [] as string[],
    fireExit: fire,
    onData: () => ({ dispose() {} }),
    onExit: (cb: ExitCb) => {
      exitCbs.push(cb);
      return { dispose() {} };
    },
    write() {},
    kill(sig?: string) {
      (this as unknown as { kills: string[] }).kills.push(sig ?? "SIGTERM");
      if (closing) return;
      closing = true;
      fire();
    },
  } as never;
}

function make(os: FakeOs, extra: Record<string, unknown> = {}) {
  const handle = fakeHandle(424242);
  const proc = new PtyAgentProcess("agent-a", handle, {
    bootDialogMaxMs: 1,
    retire: {
      signalPid: os.signalPid,
      readPidIdentity: () => "boot-1",
      liveMembers: () => (os.leader ? 1 : 0) + os.members,
      describeGroup: () => ({ count: os.members, comm: ["mcp-server"] }),
      exitGraceMs: 80,
      exitCapMs: 300,
      ...extra,
    },
  });
  return { proc, handle };
}

let warn: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  __resetGroupUnconfirmedForTests();
  __resetQuarantineForTests();
  warn = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe("PtyAgentProcess.retire", () => {
  test("TERMs through the native handle, then proves the exit from the OS: the exit callback alone is not enough", async () => {
    // Fault (site: `retireOnce`, resolve on the exit callback): resolves while the OS still
    // shows the process. Predicted result: `settled` is already true at the check below.
    const os = makeOs({ members: 1 });
    const { proc, handle } = make(os);
    let settled = false;
    const done = proc.retire().then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(handle.kills).toEqual(["SIGTERM"]);
    expect(proc._isExited()).toBe(true); // the exit callback has fired
    expect(os.leader || os.members > 0).toBe(true); // the OS still shows it
    expect(settled).toBe(false);
    await done;
    expect(os.log).toEqual([`-424242:SIGTERM`, `-424242:SIGKILL`]);
    expect(os.members).toBe(0);
  });

  test("a leader that cannot be confirmed rejects, in observe mode too, and a later retire is a fresh attempt", async () => {
    const os = makeOs({ immuneLeader: true });
    const { proc } = make(os, { groupConfirm: "observe" });
    await expect(proc.retire()).rejects.toBeInstanceOf(PtyAgentExitUnconfirmedError);
    expect(groupUnconfirmedObservedCount()).toBe(0);
    os.immuneLeader = false;
    await proc.retire();
    expect(os.leader).toBe(false);
  });

  test("leader gone, a group member survives: observe resolves with a count, enforce rejects", async () => {
    const observed = makeOs({ members: 1, immuneMembers: true });
    await make(observed, { groupConfirm: "observe" }).proc.retire();
    expect(groupUnconfirmedObservedCount()).toBe(1);

    const enforced = makeOs({ members: 1, immuneMembers: true });
    await expect(make(enforced, { groupConfirm: "enforce" }).proc.retire()).rejects.toBeInstanceOf(
      PtyAgentExitUnconfirmedError,
    );
    expect(groupUnconfirmedObservedCount()).toBe(1);
  });

  test("concurrent retire calls, one of them from the exit callback, join one retirement", async () => {
    const os = makeOs({ members: 1 });
    const { proc } = make(os);
    let fromCallback: Promise<void> | null = null;
    proc.onExit(() => {
      fromCallback = proc.retire();
    });
    const first = proc.retire();
    await first;
    expect(fromCallback).toBe(first);
    expect(os.log.filter((l) => l.endsWith("SIGTERM"))).toHaveLength(1);
  });

  test("an unrecorded identity is never signalled from the bus: not by the OS, not through the native handle", async () => {
    const os = makeOs({ immuneLeader: true });
    const { proc, handle } = make(os, { readPidIdentity: () => null });
    await expect(proc.retire()).rejects.toBeInstanceOf(PtyAgentExitUnconfirmedError);
    expect(os.log).toEqual([]);
    // The native handle is a signal too: bun-pty's kill() signals the pid it holds (#581 cp8, H4).
    // Went red (["SIGTERM"]) with the authority check removed from `_kill`; the assertion above
    // this one was blind to it, because it read the OS signal log only.
    expect(handle.kills).toEqual([]);
  });
});

// #581 cp8, H2: authority over a group whose leader is gone comes from members identified
// earlier and read again now, never from a flag or a clock.
describe("group authority after the leader is gone", () => {
  /** Members the fake OS lists for the group, with identities that a reused group id changes. */
  const rosterOf = (os: FakeOs & { salt?: string }) => () => ({
    members: Array.from({ length: os.members }, (_, i) => ({
      pid: 9000 + i,
      identity: `member-${i}${os.salt ?? ""}`,
    })),
    complete: true,
  });

  test("members identified while the leader was alive keep the group signalable after it exits", async () => {
    const os = makeOs({ members: 2 });
    const { proc, handle } = make(os, { readMembers: rosterOf(os) });
    proc.snapshotGroupMembers(); // what SessionManager.stop() does before the graceful quit
    os.leader = false; // the quit ended the leader; its members stay
    handle.fireExit();
    await proc.retire();
    // Went red (an empty log, and a rejected or observed retirement) with the snapshot removed.
    expect(os.log).toEqual([`-424242:SIGTERM`, `-424242:SIGKILL`]);
    expect(os.members).toBe(0);
    expect(groupUnconfirmedObservedCount()).toBe(0);
  });

  test("a group id reused by a stranger's group after the exit is not signalled", async () => {
    const os = Object.assign(makeOs({ members: 2, immuneMembers: true }), { salt: "" });
    const { proc, handle } = make(os, { readMembers: rosterOf(os) });
    proc.snapshotGroupMembers();
    os.leader = false;
    handle.fireExit();
    os.salt = "-stranger"; // other processes answer on the group id now
    await proc.retire(); // observe: resolves, counted
    expect(os.log).toEqual([]);
    expect(groupUnconfirmedObservedCount()).toBe(1);
  });

  test("a leader that exited with no member identified signals nothing, however long the retirement is delayed", async () => {
    const os = makeOs({ leader: false, members: 2, immuneMembers: true });
    const { proc } = make(os, { readMembers: rosterOf(os) });
    await new Promise((r) => setTimeout(r, 60));
    await proc.retire();
    expect(os.log).toEqual([]);
    expect(groupUnconfirmedObservedCount()).toBe(1);
  });
});

// #581 cp8, H4: the native kill needs the same proof as an OS signal, BEFORE it is made.
describe("the bus native kill has the same authority as an OS signal", () => {
  /** The child's identity is `recorded` at construction; `current` is what the OS says afterwards. */
  function withIdentity(recorded: string, os: FakeOs, pid = 424242) {
    let current: string | null = recorded;
    const handle = fakeHandle(pid);
    const proc = new PtyAgentProcess("agent-a", handle, {
      bootDialogMaxMs: 1,
      retire: {
        signalPid: os.signalPid,
        readPidIdentity: () => current,
        liveMembers: () => (os.leader ? 1 : 0) + os.members,
        describeGroup: () => ({ count: os.members, comm: [] }),
        exitGraceMs: 40,
        exitCapMs: 120,
      },
    });
    return { proc, handle, setIdentity: (v: string | null) => (current = v) };
  }

  test("a pid that now has another identity gets no native kill and no signal", async () => {
    const os = makeOs({ immuneLeader: true, members: 1 });
    const { proc, handle, setIdentity } = withIdentity("old", os);
    setIdentity("foreign"); // the pid was recycled before the retirement began
    await expect(proc.retire()).resolves.toBeUndefined(); // a recycled leader means the group is gone
    expect(handle.kills).toEqual([]);
    expect(os.log).toEqual([]);
  });

  test("an identity that cannot be read now gets no native kill and no signal", async () => {
    const os = makeOs({ immuneLeader: true });
    const { proc, handle, setIdentity } = withIdentity("old", os);
    setIdentity(null);
    await expect(proc.retire()).rejects.toBeInstanceOf(PtyAgentExitUnconfirmedError);
    expect(handle.kills).toEqual([]);
    expect(os.log).toEqual([]);
  });

  test("a pid that is not a valid target (init, this daemon) gets no native kill", async () => {
    for (const pid of [1, process.pid]) {
      const os = makeOs();
      const { proc, handle } = withIdentity("old", os, pid);
      proc._kill("SIGTERM");
      expect(handle.kills).toEqual([]);
    }
  });

  test("the delayed /quit fallback (`_kill`) is guarded too", () => {
    const os = makeOs();
    const { proc, handle, setIdentity } = withIdentity("old", os);
    setIdentity("foreign");
    proc._kill(); // what SessionManager.stop's 2 s fallback timer calls
    expect(handle.kills).toEqual([]);
  });

  test("positive control: the recorded process gets the native kill", () => {
    const os = makeOs();
    const { proc, handle } = withIdentity("old", os);
    proc._kill("SIGTERM");
    expect(handle.kills).toEqual(["SIGTERM"]);
  });
});

describe("schema probe teardown", () => {
  test("a probe whose exit cannot be confirmed leaves its session quarantined", async () => {
    await __confirmProbeGoneForTests(
      {
        pid: 777,
        kill() {},
        retire: () => Promise.reject(new Error("still there")),
      } as never,
      "11111111-2222-3333-4444-555555555555",
    );
    expect(quarantineSnapshot().map((q) => q.reason)).toEqual(["schema-probe-exit-unconfirmed"]);
  });

  test("a confirmed probe leaves nothing behind", async () => {
    await __confirmProbeGoneForTests(
      { kill() {}, retire: () => Promise.resolve() } as never,
      "11111111-2222-3333-4444-555555555555",
    );
    expect(quarantineSnapshot()).toEqual([]);
  });
});
