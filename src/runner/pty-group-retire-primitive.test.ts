import { describe, expect, it } from "bun:test";
import { type RetireGroupInput, retireProcessGroup } from "./pty-group-kill.js";
import type { GroupMember } from "./pty-proc-identity.js";

/**
 * #581 cp3: `retireProcessGroup`, the common termination and confirmation primitive, driven by a
 * fake OS and a virtual clock. Nothing here reaches a real pid: `signal` is the stand-in kernel,
 * and a negative pid only ever lands in `world.log`.
 */

interface World {
  leader: boolean;
  members: number;
  /** SIGKILL does not take the leader / the members. */
  immuneLeader: boolean;
  immuneMembers: boolean;
  /** SIGTERM takes the leader and the members at once. */
  termKills: boolean;
  /** `kill(-pid, 0)` answers EPERM while members exist. */
  eperm: boolean;
  log: string[];
  t: number;
  reads: number;
  /** Changes the identity of every member: the group id was reused by a stranger's group. */
  salt: string;
  /** Times the member table / the group description was read. */
  listings: number;
  described: number;
}

const PID = 5150;
const DAEMON_GROUP = 4000;

function world(init: Partial<World> = {}): World {
  return {
    leader: true,
    members: 0,
    immuneLeader: false,
    immuneMembers: false,
    termKills: false,
    eperm: false,
    log: [],
    t: 0,
    reads: 0,
    salt: "",
    listings: 0,
    described: 0,
    ...init,
  };
}

/** The members the fake OS lists for the group right now, with the identities they carry. */
function roster(w: World): GroupMember[] {
  return Array.from({ length: w.members }, (_, i) => ({
    pid: 9000 + i,
    identity: `m${i}${w.salt}`,
  }));
}

const esrch = (): Error => Object.assign(new Error("ESRCH"), { code: "ESRCH" });

function kernel(w: World) {
  return (pid: number, sig: NodeJS.Signals | 0): void => {
    const group = pid < 0;
    if (sig === 0) {
      if (group) {
        if (!w.leader && w.members === 0) throw esrch();
        if (w.eperm) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        return;
      }
      if (!w.leader) throw esrch();
      return;
    }
    w.log.push(`${pid}:${sig}`);
    const takes = sig === "SIGKILL" || w.termKills;
    if (!takes) return;
    if (!w.immuneLeader) w.leader = false;
    if (group && !w.immuneMembers) w.members = 0;
  };
}

function input(w: World, over: Partial<RetireGroupInput> = {}): RetireGroupInput {
  return {
    pid: PID,
    identity: "boot-1",
    readIdentity: () => {
      w.reads++;
      return "boot-1";
    },
    signal: kernel(w),
    groupId: PID,
    daemonGroupId: DAEMON_GROUP,
    members: [],
    readMembers: () => {
      w.listings++;
      return { members: roster(w), complete: true };
    },
    readGroupId: () => PID,
    liveMembers: () => (w.leader ? 1 : 0) + w.members,
    describe: () => {
      w.described++;
      return { count: w.members, comm: ["mcp-server"] };
    },
    initial: true,
    allowUnrecordedInitial: true,
    sendTerm: true,
    deadlineAt: 7000,
    termGraceMs: 2000,
    now: () => w.t,
    sleep: async (ms) => {
      w.t += ms;
    },
    ...over,
  };
}

describe("retireProcessGroup", () => {
  it("TERMs the group, then KILLs it after the grace, and reports leader and group gone", async () => {
    const w = world({ members: 2 });
    const out = await retireProcessGroup(input(w));
    expect(w.log).toEqual([`-${PID}:SIGTERM`, `-${PID}:SIGKILL`]);
    expect(out).toMatchObject({ leaderGone: true, groupGone: true, reason: null });
    expect(w.t).toBeGreaterThanOrEqual(2000); // the grace was spent before KILL
    expect(w.t).toBeLessThanOrEqual(2040);
  });

  it("does not wait out the grace when SIGTERM takes the group", async () => {
    const w = world({ members: 2, termKills: true });
    const out = await retireProcessGroup(input(w));
    expect(w.log).toEqual([`-${PID}:SIGTERM`]);
    expect(out.groupGone).toBe(true);
    expect(w.t).toBeLessThan(100);
  });

  // Plan injection 1: leader-only absence instead of group confirmation.
  it("a leader that dies while a member survives is NOT a confirmed group: leader gone, group not, with a reason", async () => {
    const w = world({ members: 1, immuneMembers: true });
    const out = await retireProcessGroup(input(w));
    // Went red (groupGone true) with the confirmation reduced to the leader's absence.
    expect(out).toMatchObject({
      leaderGone: true,
      groupGone: false,
      reason: "survivor",
      survivors: 1,
      comm: ["mcp-server"],
    });
  });

  it("an immune leader is not confirmed gone at all", async () => {
    const w = world({ immuneLeader: true });
    const out = await retireProcessGroup(input(w));
    expect(out.leaderGone).toBe(false);
    expect(out.groupGone).toBe(false);
  });

  it("EPERM on the group is a reason of its own, never proof of absence", async () => {
    const w = world({ members: 1, immuneMembers: true, eperm: true });
    const out = await retireProcessGroup(input(w));
    expect(out).toMatchObject({ leaderGone: true, groupGone: false, reason: "eperm" });
  });

  it("a platform that cannot count live members says 'unreadable', not 'survivor'", async () => {
    const w = world({ members: 1, immuneMembers: true });
    const out = await retireProcessGroup(
      input(w, { liveMembers: () => undefined, describe: () => ({ count: undefined, comm: [] }) }),
    );
    expect(out).toMatchObject({ leaderGone: true, groupGone: false, reason: "unreadable" });
  });

  it("one deadline for everything: nothing waits past deadlineAt, and the remaining time is what the caller has left", async () => {
    const w = world({ members: 1, immuneMembers: true, immuneLeader: true });
    const out = await retireProcessGroup(input(w, { deadlineAt: 500, termGraceMs: 2000 }));
    expect(out.groupGone).toBe(false);
    // The grace is capped by the deadline, and past the deadline there is no KILL: the cap is the
    // cap. The clock never passed it either.
    expect(w.log).toEqual([`-${PID}:SIGTERM`]);
    expect(w.t).toBeLessThanOrEqual(500 + 20);
  });

  // Plan injection 3: fresh identity revalidation immediately before each signal.
  it("a leader pid that belongs to another process before SIGTERM is never signalled", async () => {
    const w = world({ members: 1 });
    const out = await retireProcessGroup(
      input(w, {
        readIdentity: () => {
          w.reads++;
          return "boot-2";
        },
      }),
    );
    // Went red (a TERM and a KILL on -pid) with the identity read removed from the signal path.
    expect(w.log).toEqual([]);
    expect(out.groupGone).toBe(true); // a recycled leader means the group is long gone
  });

  it("a pid reused after the wait's last check is not KILLed: the identity is read again right before the signal", async () => {
    const w = world({ members: 1 });
    // Reads: 1 before SIGTERM, 2 the first check, 3 the last check of the grace, 4 right before
    // SIGKILL. The pid changes hands between 3 and 4.
    const script = ["boot-1", "boot-1", "boot-1", "boot-2"];
    let n = 0;
    await retireProcessGroup(
      input(w, {
        readIdentity: () => {
          const v = script[Math.min(n, script.length - 1)] ?? null;
          n++;
          return v;
        },
      }),
    );
    // Went red (-pid:SIGKILL logged) with the identity read removed from the KILL site.
    expect(w.log).toEqual([`-${PID}:SIGTERM`]);
    expect(w.leader).toBe(true); // the stranger on the pid was left alone
  });

  // Plan injection 4: a delayed confirmation has no first-termination privilege.
  it("a delayed confirmation never signals a group whose leader is absent, without evidence it is ours", async () => {
    const w = world({ leader: false, members: 3, immuneMembers: true });
    const out = await retireProcessGroup(input(w, { initial: false, sendTerm: false }));
    // Went red (KILL sent to a stranger's group) with "unknown may signal on a later confirmation".
    expect(w.log).toEqual([]);
    expect(out).toMatchObject({ leaderGone: true, groupGone: false, reason: "unknown-identity" });
    expect(out.members).toEqual([]); // nothing vouched for it, so nothing is carried on
  });

  it("the same delayed confirmation may signal once a member identified earlier is still in the group", async () => {
    const w = world({ leader: false, members: 3 });
    const earlier = roster(w).slice(0, 1);
    const out = await retireProcessGroup(
      input(w, { initial: false, sendTerm: false, members: earlier }),
    );
    expect(w.log).toEqual([`-${PID}:SIGKILL`]);
    expect(out.groupGone).toBe(true);
  });

  // #581 cp8, H2: the group id was reused. Its new members are not the ones identified earlier.
  it("a reused group id is not ours: the members seen earlier are gone and strangers answer", async () => {
    const w = world({ leader: false, members: 2, immuneMembers: true });
    const earlier = roster(w);
    w.salt = "-stranger"; // same pids' slots, other processes: the old members are gone
    const out = await retireProcessGroup(
      input(w, { initial: false, sendTerm: false, members: earlier }),
    );
    // Went red (-pid:SIGKILL logged) with the fresh read of the earlier members removed.
    expect(w.log).toEqual([]);
    expect(out).toMatchObject({ groupGone: false, reason: "unknown-identity" });
    expect(out.members).toEqual([]);
  });

  it("the members of a group that stays are carried on as known before it, never added to (cp10)", async () => {
    const stays = world({ leader: false, members: 2, immuneMembers: true });
    const earlier = roster(stays).slice(0, 1);
    const held = await retireProcessGroup(
      input(stays, { initial: false, sendTerm: false, members: earlier }),
    );
    expect(held.groupGone).toBe(false);
    // The second member was never identified while the leader lived: a listing made inside the
    // retirement does not add it.
    expect(held.members).toEqual(earlier);

    // Nor does the initial retirement of a live leader learn its group: it learns no member.
    const live = world({ members: 1, immuneMembers: true });
    const initial = await retireProcessGroup(input(live));
    expect(initial).toMatchObject({ leaderGone: true, groupGone: false });
    expect(initial.members).toEqual([]);
  });

  it("a group found absent hands nothing on", async () => {
    const w = world({ leader: false, members: 0 });
    const out = await retireProcessGroup(
      input(w, {
        initial: false,
        sendTerm: false,
        members: [{ pid: 9000, identity: "m0" }],
      }),
    );
    expect(out.members).toEqual([]);
    expect(out.groupGone).toBe(true);
    expect(w.log).toEqual([]);
  });

  // #581 cp8, L1: a negative target needs an isolated group that is not the daemon's.
  it("never signals -pid unless the child led a group of its own that is not the daemon's", async () => {
    const cases: Array<[string, Partial<RetireGroupInput>]> = [
      ["the child shares another group", { groupId: 777 }],
      ["the group id was unreadable", { groupId: null }],
      ["the group is the daemon's own", { daemonGroupId: PID, readGroupId: () => PID }],
      ["the daemon's group is unreadable", { daemonGroupId: null }],
    ];
    for (const [why, over] of cases) {
      const w = world({ members: 1 });
      await retireProcessGroup(
        input(w, { readGroupId: () => (over.groupId as number) ?? null, ...over }),
      );
      // Went red (a -pid line) with the isolation check removed from the group send.
      expect(
        w.log.filter((l) => l.startsWith("-")),
        why,
      ).toEqual([]);
      // The leader itself is still ours to signal: its identity matches.
      expect(
        w.log.some((l) => l.startsWith(`${PID}:`)),
        why,
      ).toBe(true);
    }
  });

  it("reads the child's group id again while the leader is the recorded process: a reading taken before setsid() does not stick", async () => {
    const w = world({ members: 1 });
    const out = await retireProcessGroup(input(w, { groupId: 777, readGroupId: () => PID }));
    expect(w.log[0]).toBe(`-${PID}:SIGTERM`);
    expect(out.groupId).toBe(PID);
  });

  // #581 cp8, M2: one absolute deadline; past it nothing is signalled, listed or described.
  it("does no TERM, KILL, listing or description once the deadline has passed", async () => {
    const w = world({ leader: false, members: 2, immuneMembers: true });
    w.t = 10_000; // already past deadlineAt (7000)
    const out = await retireProcessGroup(
      input(w, { initial: false, members: roster(w), sendTerm: true }),
    );
    expect(w.log).toEqual([]);
    expect(w.listings).toBe(0);
    expect(w.described).toBe(0);
    expect(out).toMatchObject({ leaderGone: true, groupGone: false }); // unresolved stays held
  });

  it("an identity that cannot be read on a delayed confirmation signals nothing", async () => {
    const w = world({ members: 1, immuneMembers: true });
    const out = await retireProcessGroup(
      input(w, { initial: false, sendTerm: false, readIdentity: () => null }),
    );
    expect(w.log).toEqual([]);
    expect(out.groupGone).toBe(false);
  });

  it("an unrecorded identity may be signalled in the initial window only when the caller allows it", async () => {
    const allowed = world({ members: 1 });
    await retireProcessGroup(input(allowed, { identity: null, readIdentity: () => null }));
    expect(allowed.log.length).toBeGreaterThan(0);

    const refused = world({ members: 1 });
    await retireProcessGroup(
      input(refused, { identity: null, readIdentity: () => null, allowUnrecordedInitial: false }),
    );
    expect(refused.log).toEqual([]);
  });

  it("a pid that cannot name a group (1, 0, -1) is never signalled", async () => {
    for (const bad of [1, 0, -1]) {
      const w = world({ members: 1 });
      const out = await retireProcessGroup(input(w, { pid: bad }));
      expect(w.log).toEqual([]);
      expect(out.leaderGone).toBe(false);
    }
  });
});
