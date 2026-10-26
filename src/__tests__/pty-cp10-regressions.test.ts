/**
 * #581 cp10: regressions for Codex's re-review of 726f27c8 (H2 still open, H5 new) and the
 * strict form of option B ruled on 26 Oct: members are learned only while the leader is alive
 * and no retirement has begun. Built from Codex's boundary probes, asserting the fixed outcome.
 */
import { describe, expect, test } from "bun:test";
import { PtyAgentProcess } from "../bus/session-agent-process";
import { noteGroupMembers, retireProcessGroup } from "../runner/pty-group-kill";
import { spawnPty } from "../runner/pty-process";

const LEADER = 424242;
const DAEMON_GROUP = 999;
const esrch = (): Error => Object.assign(new Error("ESRCH"), { code: "ESRCH" });
const foreign = [{ pid: 424243, identity: "foreign" }];
const groupOf = (p: number): number => (p === process.pid ? DAEMON_GROUP : p);

/**
 * A leader that exits, and its group number is reused, during a read: the group listing, or
 * the read of the leader's group id that a retirement makes before it signals.
 */
function vanishingLeader(during: "listing" | "group-id" = "listing") {
  let alive = true;
  const sent: Array<[number, unknown]> = [];
  return {
    sent,
    pid: LEADER,
    identity: "original",
    groupId: LEADER,
    daemonGroupId: DAEMON_GROUP,
    signal: (pid: number, s: unknown): void => {
      if (s === 0) {
        if (pid > 0 && !alive) throw esrch();
        return;
      }
      sent.push([pid, s]);
    },
    readIdentity: () => (alive ? "original" : null),
    readGroupId: (p: number) => {
      if (during === "group-id" && p === LEADER) alive = false;
      return groupOf(p);
    },
    readMembers: () => {
      if (during === "listing") alive = false;
      return { members: foreign, complete: true };
    },
  };
}

const retireBase = {
  allowUnrecordedInitial: false,
  sendTerm: true,
  termGraceMs: 0,
  liveMembers: () => 1,
  describe: () => ({ count: 1, comm: ["foreign"] }),
};

describe("H2: the leader is checked again after the group is listed", () => {
  test("noteGroupMembers learns nothing from a listing the leader did not outlive", async () => {
    const os = vanishingLeader();
    const { sent, ...deps } = os;
    const noted = noteGroupMembers({ ...deps, members: [] });
    // Went red (the foreign member) at 726f27c8 and with the recheck after the listing removed (I1).
    expect(noted.members).toEqual([]);
    await retireProcessGroup({
      ...deps,
      ...retireBase,
      members: noted.members,
      groupId: noted.groupId,
      initial: false,
      deadlineAt: Date.now() + 12,
    });
    // Went red ([-424242 SIGTERM, SIGKILL]) at 726f27c8: the foreign member vouched for the group.
    expect(sent).toEqual([]);
  });

  test("a retirement learns no member, so a listing made in it cannot vouch for a foreign group", async () => {
    const os = vanishingLeader("group-id");
    const { sent, ...deps } = os;
    await retireProcessGroup({
      ...deps,
      ...retireBase,
      members: [],
      initial: true,
      deadlineAt: Date.now() + 12,
    });
    // Went red ([-424242 SIGTERM, SIGKILL]) at 726f27c8 and with the retirement learning the
    // group at its start again (I2).
    expect(sent).toEqual([]);
  });
});

/** A bun-pty handle whose kill() fires the exit callbacks synchronously. */
function nativeHandle() {
  const exits: Array<(e: { exitCode: number }) => void> = [];
  const handle = {
    pid: LEADER,
    kills: [] as string[],
    inKill: false,
    onExit(f: (e: { exitCode: number }) => void) {
      exits.push(f);
      return { dispose() {} };
    },
    onData() {
      return { dispose() {} };
    },
    write() {},
    resize() {},
    kill(s: string) {
      handle.kills.push(s);
      handle.inKill = true;
      try {
        for (const f of exits) f({ exitCode: 0 });
      } finally {
        handle.inKill = false;
      }
    },
  };
  return handle;
}

const security = { level: "unrestricted", allowedTools: [], disallowedTools: [] } as const;

describe("option B, strict: no member look at the exit or inside a retirement", () => {
  test("bus: a retirement that failed and was cleared for retry still closes the live look (OB1)", async () => {
    const h = nativeHandle();
    let identity: string | null = "id"; // recorded at spawn
    let listed = 0;
    const p = new PtyAgentProcess("cp10-ob1", h as never, {
      bootDialogMaxMs: 1,
      retire: {
        readPidIdentity: () => identity,
        readPgid: groupOf,
        readMembers: () => {
          listed++;
          return { members: foreign, complete: true };
        },
        signalPid: () => {},
        liveMembers: () => 1,
        describeGroup: () => ({ count: 1, comm: ["leader"] }),
        exitCapMs: 12,
        exitGraceMs: 0,
      },
    });
    // Unreadable at retirement: no native kill, no exit callback, the retirement rejects.
    identity = null;
    await expect(p.retire()).rejects.toThrow();
    expect(h.kills).toEqual([]);
    identity = "id"; // readable again: the leader reads as the recorded process
    const before = listed;
    p.noteLiveGroup(); // what a queued prompt or slash command does next
    // Went red (Received: 1) at 093b1524, and with the guard back on `_retirement === null` (I7).
    expect(listed).toBe(before);
  });

  test("bus: the native exit callback fired by the retirement's kill lists nothing", async () => {
    const h = nativeHandle();
    let listedInKill = 0;
    const p = new PtyAgentProcess("cp10", h as never, {
      bootDialogMaxMs: 1,
      retire: {
        readPidIdentity: () => "id",
        readPgid: groupOf,
        readMembers: () => {
          if (h.inKill) listedInKill++;
          return { members: [], complete: true };
        },
        signalPid: () => {},
        liveMembers: () => 0,
        exitCapMs: 80,
        exitGraceMs: 0,
      },
    });
    await p.retire();
    expect(h.kills).toEqual(["SIGTERM"]);
    // Went red (1) at 726f27c8 and with the member look put back in the bus exit callback (I3).
    expect(listedInKill).toBe(0);
  });

  test("runner: neither the retirement nor the exit callback it fires lists the group", async () => {
    const h = nativeHandle();
    let retiring = false;
    let listedInRetirement = 0;
    const p = await spawnPty({
      cwd: "/tmp",
      sessionId: "",
      env: {},
      security,
      _ptySpawn: (() => h) as never,
      _skipReadySettle: true,
      _skipClaudeArgs: true,
      transcriptPath: "/tmp/cp10-unused.jsonl",
      _readPidIdentity: () => "id",
      _readPgid: groupOf,
      _readMembers: () => {
        if (retiring) listedInRetirement++;
        return { members: [], complete: true };
      },
      _signalPid: () => {
        if (h.kills.length > 0) throw esrch();
      },
      _liveMembers: () => 0,
      _exitGraceMs: 0,
      _exitCapMs: 80,
    } as never);
    retiring = true;
    await p.dispose().catch(() => {});
    expect(h.kills).toEqual(["SIGTERM"]);
    // Went red (1) at 726f27c8 and with the snapshot at the runner retirement start put back (I4).
    expect(listedInRetirement).toBe(0);
  });

  test("runner: an exit callback bun-pty fires from kill() while the leader still lives lists nothing", async () => {
    const h = nativeHandle();
    let listedInKill = 0;
    const p = await spawnPty({
      cwd: "/tmp",
      sessionId: "",
      env: {},
      security,
      _ptySpawn: (() => h) as never,
      _skipReadySettle: true,
      _skipClaudeArgs: true,
      transcriptPath: "/tmp/cp10-unused.jsonl",
      _readPidIdentity: () => "id",
      _readPgid: groupOf,
      _readMembers: () => {
        if (h.inKill) listedInKill++;
        return { members: [], complete: true };
      },
      // The leader is still there when the synthesised callback runs: the identity reads "same".
      _signalPid: () => {},
      _liveMembers: () => 0,
      _exitGraceMs: 0,
      _exitCapMs: 40,
    } as never);
    await p.dispose().catch(() => {});
    expect(h.kills.length).toBeGreaterThan(0);
    // Went red (1) with the member look put back in the runner exit callback (I6), and at 726f27c8.
    expect(listedInKill).toBe(0);
  });
});

describe("H5: the runner's native kill needs a fresh positive identity", () => {
  test("an identity that cannot be read now withholds bun-pty's kill", async () => {
    const h = nativeHandle();
    let current: string | null = "id";
    const p = await spawnPty({
      cwd: "/tmp",
      sessionId: "",
      env: {},
      security,
      _ptySpawn: (() => h) as never,
      _skipReadySettle: true,
      _skipClaudeArgs: true,
      transcriptPath: "/tmp/cp10-unused.jsonl",
      _readPidIdentity: () => current,
      _readPgid: groupOf,
      _readMembers: () => ({ members: [], complete: true }),
      _signalPid: () => {},
      _liveMembers: () => 0,
      _exitGraceMs: 0,
      _exitCapMs: 80,
    } as never);
    current = null;
    await p.dispose().catch(() => {});
    // Went red (["SIGTERM"]) at 726f27c8, and with cp10 H5 reverted to `!== "replaced"` (I5).
    expect(h.kills).toEqual([]);
  });

  test("the recorded process, read again now, is still killed through bun-pty", async () => {
    const h = nativeHandle();
    const p = await spawnPty({
      cwd: "/tmp",
      sessionId: "",
      env: {},
      security,
      _ptySpawn: (() => h) as never,
      _skipReadySettle: true,
      _skipClaudeArgs: true,
      transcriptPath: "/tmp/cp10-unused.jsonl",
      _readPidIdentity: () => "id",
      _readPgid: groupOf,
      _readMembers: () => ({ members: [], complete: true }),
      _signalPid: () => {
        if (h.kills.length > 0) throw esrch();
      },
      _liveMembers: () => 0,
      _exitGraceMs: 0,
      _exitCapMs: 80,
    } as never);
    await p.dispose().catch(() => {});
    expect(h.kills).toEqual(["SIGTERM"]);
  });
});
