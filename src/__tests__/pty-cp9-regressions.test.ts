/**
 * #581 cp9: regression tests for Codex's re-review of b1f36287 (H2 and M2 still open, CI1 new).
 *
 * Each test is black-box: it uses only seams and APIs that exist at b1f36287 and at the fix, so the
 * same file runs unchanged against `git archive b1f36287` (RED) and the fixed head (GREEN). A seam
 * or option one side does not know (`leaderJustExited`, a walk `deadlineAt`) is passed anyway and
 * ignored there. Nothing here can signal a real pid: the OS is a stand-in throughout.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyAgentProcess, type PtyHandle } from "../bus/session-agent-process";
import { findEscapees } from "../runner/pty-escape-scan";
import { __resetGroupUnconfirmedForTests } from "../runner/pty-group-confirm";
import { describeGroup, noteGroupMembers, retireProcessGroup } from "../runner/pty-group-kill";
import type { GroupMember } from "../runner/pty-proc-identity";
import { type PtyProcessOptions, spawnPty } from "../runner/pty-process";
import { __resetQuarantineForTests } from "../runner/pty-quarantine";
import { TranscriptTurn } from "../runner/pty-transcript";
import { fakeTurn, tempTranscript } from "./fixtures/fake-claude-tui";

const esrch = (): Error => Object.assign(new Error("ESRCH"), { code: "ESRCH" });

type ExitCb = (info: { exitCode: number; signal?: number | string }) => void;

/** bun-pty 0.4.9: the FIRST kill() fires the exit event synchronously, whatever the signal. */
function fakeNative(pid = 424242) {
  const exits: ExitCb[] = [];
  let closing = false;
  const fire = (): void => {
    for (const cb of [...exits]) cb({ exitCode: 0 });
  };
  const handle = {
    pid,
    kills: [] as string[],
    fire,
    onExit: (cb: ExitCb) => {
      exits.push(cb);
      return { dispose() {} };
    },
    onData: (_cb: (chunk: string) => void) => ({ dispose() {} }),
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

const security: PtyProcessOptions["security"] = {
  level: "unrestricted",
  allowedTools: [],
  disallowedTools: [],
};

/** A foreign process left in a reused group number: never ours, whatever the exit callback says. */
const FOREIGN: GroupMember[] = [{ pid: 424243, identity: "foreign-child" }];

let warn: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  __resetQuarantineForTests();
  __resetGroupUnconfirmedForTests();
  warn = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  __resetQuarantineForTests();
});

describe("H2: a delayed native exit callback creates no signal authority", () => {
  test("the exit-time look learns nothing from an absent leader that nothing known vouches for", async () => {
    const sent: Array<[number, unknown]> = [];
    const signal = (pid: number, s: unknown): void => {
      if (s === 0) {
        if (pid > 0) throw esrch(); // the leader is gone; the reused group number answers
        return;
      }
      sent.push([pid, s]);
    };
    const reuse = {
      pid: 424242,
      identity: "original",
      groupId: 424242,
      signal,
      readIdentity: () => null,
      readGroupId: () => 999,
      daemonGroupId: 999,
      readMembers: () => ({ members: FOREIGN, complete: true }),
    };
    // b1f36287 took the exit flag as proof and recorded FOREIGN here.
    const noted = noteGroupMembers({
      ...reuse,
      members: [],
      leaderJustExited: true,
    } as Parameters<typeof noteGroupMembers>[0]);
    expect(noted.members).toEqual([]);
    // ...and the retirement that followed revalidated FOREIGN and signalled -424242 TERM and KILL.
    await retireProcessGroup({
      ...reuse,
      groupId: noted.groupId,
      members: noted.members,
      liveMembers: () => 1,
      describe: () => ({ count: 1, comm: ["foreign"] }),
      initial: false,
      allowUnrecordedInitial: false,
      sendTerm: true,
      deadlineAt: Date.now() + 15,
      termGraceMs: 0,
    });
    expect(sent).toEqual([]);
  });

  test("bus: an exit callback delivered after the group number was reused signals nothing", async () => {
    const handle = fakeNative();
    let leader = true;
    let reused = false;
    const sent: Array<[number, unknown]> = [];
    const proc = new PtyAgentProcess("cp9-h2", handle as unknown as PtyHandle, {
      bootDialogMaxMs: 1,
      retire: {
        readPidIdentity: () => (leader ? "id" : null),
        readPgid: (pid: number) => (pid === process.pid ? 999 : pid),
        readMembers: () => ({ members: reused ? FOREIGN : [], complete: true }),
        signalPid: (pid: number, s: unknown) => {
          if (s === 0) {
            if (pid > 0 && !leader) throw esrch();
            return;
          }
          sent.push([pid, s]);
        },
        liveMembers: () => 1,
        describeGroup: () => ({ count: 1, comm: ["foreign"] }),
        groupConfirm: "enforce",
        exitCapMs: 120,
        exitGraceMs: 1,
      },
    });
    leader = false; // the leader went while nobody looked; its group went too
    reused = true; // the number was reused and a foreign child now sits in it
    handle.fire(); // ...and only now is the old exit event delivered
    await proc.retire().catch(() => {});
    expect(sent.filter(([pid]) => pid < 0)).toEqual([]);
  });

  test("runner: an exit callback delivered after the group number was reused signals nothing", async () => {
    const handle = fakeNative();
    let leader = true;
    let reused = false;
    const sent: Array<[number, unknown]> = [];
    const proc = await spawnPty({
      sessionId: "",
      cwd: "/tmp",
      env: {},
      security,
      _ptySpawn: (() => handle) as never,
      _skipReadySettle: true,
      _skipClaudeArgs: true,
      transcriptPath: "/tmp/cp9-never-written.jsonl",
      _readPidIdentity: () => (leader ? "id" : null),
      _readPgid: (pid: number) => (pid === process.pid ? 999 : pid),
      _readMembers: () => ({ members: reused ? FOREIGN : [], complete: true }),
      _signalPid: (pid: number, s: unknown) => {
        if (s === 0) {
          if (pid > 0 && !leader) throw esrch();
          return;
        }
        sent.push([pid, s]);
      },
      _liveMembers: () => 1,
      _describeGroup: () => ({ count: 1, comm: ["foreign"] }),
      _groupConfirm: "enforce",
      _exitGraceMs: 1,
      _exitCapMs: 120,
    } as PtyProcessOptions);
    leader = false;
    reused = true;
    handle.fire();
    await proc.dispose().catch(() => {});
    expect(sent.filter(([pid]) => pid < 0)).toEqual([]);
  });
});

describe("H2 (option B): members learned while the leader is alive keep a natural exit retirable", () => {
  test("bus: members seen before a typed command vouch for the group after the leader exits", async () => {
    // Fault (site: `noteLiveGroup` call in `send_slash`): nothing was learned while the leader
    // lived, so nothing vouches for the group. Predicted result: no group signal at all.
    const handle = fakeNative();
    let leader = true;
    let members: GroupMember[] = [];
    const sent: Array<[number, unknown]> = [];
    const proc = new PtyAgentProcess("cp9-live", handle as unknown as PtyHandle, {
      bootDialogMaxMs: 1,
      retire: {
        readPidIdentity: () => (leader ? "id" : null),
        readPgid: (pid: number) => (pid === process.pid ? 999 : pid),
        readMembers: () => ({ members, complete: true }),
        signalPid: (pid: number, s: unknown) => {
          if (s === 0) {
            if (pid > 0 ? !leader : members.length === 0) throw esrch();
            return;
          }
          sent.push([pid, s]);
          if (s === "SIGKILL" && pid < 0) members = [];
        },
        liveMembers: () => (leader ? 1 : 0) + members.length,
        describeGroup: () => ({ count: members.length, comm: ["mcp-server"] }),
        groupConfirm: "enforce",
        exitCapMs: 500,
        exitGraceMs: 1,
      },
    });
    members = [{ pid: 9100, identity: "mcp-server" }]; // a server the CLI started after spawn
    await proc.send_slash("status");
    leader = false; // the leader exits on its own, leaving the server behind
    handle.fire();
    await proc.retire();
    expect(sent.filter(([pid]) => pid < 0).map(([, s]) => s)).toContain("SIGKILL");
    expect(members).toEqual([]);
  });

  test("runner: a server the turn started is learned when the turn ends cleanly", async () => {
    // Fault (site: `_noteLiveGroup` call in `_completeTurn`): the server joined during the turn,
    // after the turn-start look, so nothing vouches for it once the leader is gone. Predicted
    // result: no group signal at all.
    const t = tempTranscript();
    let leader = true;
    let members: GroupMember[] = [];
    const sent: Array<[number, unknown]> = [];
    const proc = await spawnPty({
      sessionId: "",
      cwd: "/tmp",
      env: { ...process.env } as Record<string, string>,
      security,
      _skipReadySettle: true,
      _skipClaudeArgs: true,
      _commandOverride: "/bin/sh",
      _argsOverride: [
        "-c",
        `${fakeTurn({ tx: t.path, prompt: "hello", answer: "done" })}; sleep 1`,
      ],
      transcriptPath: t.path,
      quietWindowMs: 50,
      settleCapMs: 400,
      submitConfirmMs: 400,
      _readPidIdentity: () => (leader ? "id" : null),
      _readPgid: (pid: number) => (pid === process.pid ? 999 : pid),
      _readMembers: () => ({ members, complete: true }),
      _signalPid: (pid: number, s: unknown) => {
        if (s === 0) {
          if (pid > 0 ? !leader : members.length === 0) throw esrch();
          return;
        }
        sent.push([pid, s]);
        if (s === "SIGKILL" && pid < 0) members = [];
      },
      _liveMembers: () => (leader ? 1 : 0) + members.length,
      _describeGroup: () => ({ count: members.length, comm: ["mcp-server"] }),
      _groupConfirm: "enforce",
      _exitGraceMs: 1,
      _exitCapMs: 500,
    } as PtyProcessOptions);
    try {
      const turn = proc.runTurn("hello", { timeoutMs: 5_000 });
      members = [{ pid: 9200, identity: "lazy-server" }]; // started by a tool, mid-turn
      expect((await turn).text).toBe("done");
      leader = false; // the leader then exits on its own, leaving the server behind
      await proc.dispose();
    } finally {
      t.cleanup();
    }
    expect(sent.filter(([pid]) => pid < 0).map(([, s]) => s)).toContain("SIGKILL");
  });
});

describe("M2: one absolute deadline, rechecked after every read and before every signal", () => {
  test("a group signal is not sent when the identity read before it crossed the deadline", async () => {
    let now = 0;
    let reads = 0;
    const sent: Array<{ pid: number; s: unknown; at: number }> = [];
    await retireProcessGroup({
      pid: 424242,
      identity: "id",
      groupId: 424242,
      members: [],
      daemonGroupId: 999,
      readGroupId: () => 424242,
      readMembers: () => ({ members: [], complete: true }),
      readIdentity: () => {
        if (++reads === 2) now = 20; // the second read ends past the 10 ms deadline
        return "id";
      },
      signal: (pid: number, s: unknown) => {
        if (s !== 0) sent.push({ pid, s, at: now });
      },
      liveMembers: () => 1,
      initial: true,
      allowUnrecordedInitial: false,
      sendTerm: true,
      deadlineAt: 10,
      termGraceMs: 0,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      describe: () => ({ count: 1, comm: [] }),
    });
    // b1f36287 logged {pid:-424242, s:"SIGTERM", at:20}.
    expect(sent.filter((x) => x.at >= 10)).toEqual([]);
  });

  test("bus: a cap of zero covers the member snapshot and the native kill too", async () => {
    const handle = fakeNative();
    let alive = true;
    const native: string[] = [];
    handle.kill = (sig = "SIGTERM") => {
      native.push(sig);
      alive = false;
      handle.fire();
    };
    const proc = new PtyAgentProcess("cp9-m2", handle as unknown as PtyHandle, {
      bootDialogMaxMs: 1,
      retire: {
        readPidIdentity: () => "id",
        readPgid: (pid: number) => pid,
        readMembers: () => {
          Bun.sleepSync(35); // a member listing that takes longer than the whole cap
          return { members: [], complete: true };
        },
        signalPid: (_pid: number, s: unknown) => {
          if (s === 0 && !alive) throw esrch();
        },
        liveMembers: () => 0,
        exitCapMs: 0,
        exitGraceMs: 0,
      },
    });
    await proc.retire().catch(() => {});
    // b1f36287 snapshotted first, then started its cap, then native-killed with SIGTERM.
    expect(native).toEqual([]);
  });

  test("the Linux describeGroup walk stops at the deadline and reports no count", () => {
    const procDir = mkdtempSync(join(tmpdir(), "cp9-proc-"));
    try {
      for (const pid of [5001, 5002]) {
        mkdirSync(join(procDir, String(pid)));
        writeFileSync(join(procDir, String(pid), "stat"), `${pid} (member) S 1 4242 4242 0`);
      }
      // b1f36287 ignored the deadline in this walk and counted both members.
      expect(describeGroup(4242, Date.now() - 1, procDir).count).toBeUndefined();
      expect(describeGroup(4242, Date.now() + 60_000, procDir).count).toBe(2); // control
    } finally {
      rmSync(procDir, { recursive: true, force: true });
    }
  });

  test("the escape scan's /proc walk stops at the deadline and says it did not finish", () => {
    const procDir = mkdtempSync(join(tmpdir(), "cp9-proc-"));
    const root = "/tmp/cp9-escape-root";
    try {
      mkdirSync(join(procDir, "6001"));
      writeFileSync(join(procDir, "6001", "environ"), `CLAUDE_CONFIG_DIR=${root}\0`);
      writeFileSync(join(procDir, "6001", "stat"), "6001 (escapee) S 1 6001 6001 0");
      const opts = { procDir, selfPid: 1, uid: process.getuid?.(), now: () => 100 };
      const target = { root, cwds: [] as string[] };
      // b1f36287 had no deadline in this walk: it read the process and reported it.
      const late = findEscapees(target, { ...opts, deadlineAt: 50 } as Parameters<
        typeof findEscapees
      >[1]);
      expect(late.pids).toEqual([]);
      expect((late as { incomplete?: boolean }).incomplete).toBe(true);
      const control = findEscapees(target, { ...opts, deadlineAt: 1_000 } as Parameters<
        typeof findEscapees
      >[1]);
      expect(control.pids).toEqual([6001]);
    } finally {
      rmSync(procDir, { recursive: true, force: true });
    }
  });
});

describe("CI1: an isMeta expansion never establishes slash-command acceptance", () => {
  const line = (content: string, extra: Record<string, unknown> = {}): string =>
    `${JSON.stringify({ type: "user", message: { role: "user", content }, ...extra })}\n`;

  function withTranscript(run: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "cp9-meta-"));
    try {
      run(join(dir, "session.jsonl"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a different command's expansion holding an exact `/wanted` record does not accept `/wanted`", () => {
    withTranscript((path) => {
      writeFileSync(path, line("<command-name>/wanted</command-name>")); // before mark(): not ours
      const turn = new TranscriptTurn({ path, written: "/wanted" });
      turn.mark();
      appendFileSync(path, line("<command-name>/different</command-name>"));
      appendFileSync(path, line("<command-name>/wanted</command-name>", { isMeta: true }));
      // b1f36287 accepted here.
      expect(turn.poll().accepted).toBe(false);
    });
  });

  test("control: the genuine command record still accepts it", () => {
    withTranscript((path) => {
      writeFileSync(path, "");
      const turn = new TranscriptTurn({ path, written: "/wanted" });
      turn.mark();
      appendFileSync(path, line("<command-name>/wanted</command-name>"));
      expect(turn.poll().accepted).toBe(true);
    });
  });
});
