import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSignalablePid,
  procLiveMembers,
  processGroupGone,
  terminateProcessGroup,
  type SignalFn,
} from "./pty-group-kill.js";

/** #570 r12 (A): a retired PTY child must be proven gone, with its group. */

const PID = 424242;
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

/** A process table: the group dies on the given signal (or never). */
function fakeKernel(diesOn: NodeJS.Signals | null, { visible = true } = {}) {
  const calls: Array<[number, NodeJS.Signals | 0]> = [];
  let alive = true;
  const signal: SignalFn = (target, name) => {
    calls.push([target, name]);
    if (name === 0) {
      if (!alive || !visible) throw errno("ESRCH");
      return;
    }
    if (name === diesOn) alive = false;
  };
  return { signal, calls };
}

const instant = { sleep: async () => {}, liveMembers: () => undefined, pollMs: 100 };

describe("terminateProcessGroup", () => {
  it("SIGTERMs the group and the leader, and is done once both answer ESRCH", async () => {
    const k = fakeKernel("SIGTERM");
    expect(await terminateProcessGroup(PID, { signal: k.signal, ...instant })).toBe(true);
    expect(k.calls.filter(([, n]) => n === "SIGTERM")).toEqual([
      [-PID, "SIGTERM"],
      [PID, "SIGTERM"],
    ]);
    expect(k.calls.some(([, n]) => n === "SIGKILL")).toBe(false);
  });

  it("escalates to SIGKILL when the group outlives SIGTERM", async () => {
    const k = fakeKernel("SIGKILL");
    // Went red (false, then no SIGKILL calls) with the escalation removed.
    expect(await terminateProcessGroup(PID, { signal: k.signal, ...instant })).toBe(true);
    expect(k.calls.filter(([, n]) => n === "SIGKILL")).toEqual([
      [-PID, "SIGKILL"],
      [PID, "SIGKILL"],
    ]);
  });

  it("reports failure, never success, when the group survives SIGKILL", async () => {
    const k = fakeKernel(null);
    expect(await terminateProcessGroup(PID, { signal: k.signal, ...instant })).toBe(false);
  });

  it("does not take the leader's disappearance for the group's", async () => {
    // kill(pid, 0) says ESRCH (leader reaped) but the group still has a member.
    const signal: SignalFn = (target, name) => {
      if (name === 0 && target === PID) throw errno("ESRCH");
    };
    // Went red (true) with only the leader checked.
    expect(await terminateProcessGroup(PID, { signal, ...instant })).toBe(false);
  });

  it("reads EPERM as alive, not gone", async () => {
    const signal: SignalFn = (_target, name) => {
      if (name === 0) throw errno("EPERM");
    };
    // Went red (true) with every error read as "gone".
    expect(await terminateProcessGroup(PID, { signal, ...instant })).toBe(false);
  });

  it("counts an unreaped zombie as gone where /proc can tell, and not otherwise", () => {
    const zombie: SignalFn = () => {}; // kill(.., 0) succeeds for a zombie
    // Went red (false) with the /proc answer ignored.
    expect(processGroupGone(PID, zombie, () => 0)).toBe(true);
    expect(processGroupGone(PID, zombie, () => 1)).toBe(false);
    expect(processGroupGone(PID, zombie, () => undefined)).toBe(false);
  });

  it("never signals a pid that could reach init, itself, or every process", async () => {
    for (const pid of [0, 1, -1, -PID, Number.NaN, 1.5, process.pid]) {
      const k = fakeKernel("SIGTERM");
      // Went red (true) with the pid guard removed.
      expect(isSignalablePid(pid)).toBe(false);
      expect(await terminateProcessGroup(pid, { signal: k.signal, ...instant })).toBe(false);
      expect(k.calls).toEqual([]);
    }
  });
});

describe("procLiveMembers", () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), "fake-proc-"));
  });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  const entry = (pid: number, comm: string, state: string, pgrp: number): void => {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(
      join(proc, String(pid), "stat"),
      `${pid} (${comm}) ${state} 1 ${pgrp} ${pgrp} 0\n`,
    );
  };

  it("counts live members of the group, not zombies or other groups", () => {
    entry(PID, "sh", "Z", PID); // the leader, dead and unreaped
    entry(PID + 1, "sleep", "S", PID); // a live member
    entry(PID + 2, "other", "S", 777); // another group
    mkdirSync(join(proc, "self")); // not a pid
    expect(procLiveMembers(PID, proc)).toBe(1);
  });

  it("parses a command name that contains spaces and parentheses", () => {
    entry(PID + 1, "a) S 1 1 (b", "S", PID);
    expect(procLiveMembers(PID, proc)).toBe(1);
  });

  it("is zero when only zombies are left", () => {
    entry(PID, "sh", "Z", PID);
    expect(procLiveMembers(PID, proc)).toBe(0);
  });
});
