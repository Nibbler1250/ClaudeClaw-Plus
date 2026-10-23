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

  test("an unrecorded identity is never signalled from the bus", async () => {
    const os = makeOs({ immuneLeader: true });
    const { proc } = make(os, { readPidIdentity: () => null });
    await expect(proc.retire()).rejects.toBeInstanceOf(PtyAgentExitUnconfirmedError);
    expect(os.log).toEqual([]);
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
