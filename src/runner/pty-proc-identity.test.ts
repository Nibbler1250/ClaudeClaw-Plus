import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BsdInfo, type KinfoProc, libprocGroupPids } from "./libproc.js";
import {
  compareIdentity,
  compareStartMs,
  currentBootId,
  type IdentityReadDeps,
  pidIdentity,
  procStartMs,
  processStartMs,
  readBootId,
  readGroupMembers,
  readPidIdentity,
  readPidSnapshot,
  recordedOnAnotherBoot,
  sameIdentity,
  sameStart,
  startMsFromIdentity,
  TEST_BOOT_ID,
} from "./pty-proc-identity.js";
import { noteGroupMembers } from "./pty-group-kill.js";
import { withPlatform } from "./pty-test-platform.js";

/** One libproc `proc_bsdinfo` reading, as `libprocBsdInfo` returns it. */
const info = (pid: number, sec: number, usec: number, pgid = pid, status = 2): BsdInfo => ({
  pid,
  status,
  uid: 501,
  pgid,
  name: "claude",
  start: { sec, usec },
});

/** #570 r14 (E): on Linux the start time comes from `/proc/<pid>/stat` field 22, not from `ps`. */

describe("procStartMs (fake /proc)", () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), "fake-proc-"));
  });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  const stat = (pid: number, text: string): void => {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(join(proc, String(pid), "stat"), text);
  };
  // Fields 3..22 after the command: state, ppid, pgrp, session, tty, tpgid, flags, minflt,
  // cminflt, majflt, cmajflt, utime, stime, cutime, cstime, priority, nice, threads, itreal, starttime.
  const AFTER = "S 1 123 123 0 -1 4194304 100 0 0 0 5 6 0 0 20 0 1 0 12345 99999 8888";

  it("reads field 22 (ticks since boot) as milliseconds", () => {
    stat(123, `123 (sleep) ${AFTER}\n`);
    // Went red (0) with field 21 read instead of field 22.
    expect(procStartMs(123, proc)).toBe(123_450);
  });

  it("is not thrown by a command name with spaces and parentheses", () => {
    stat(124, `124 (a) b) (c d) ${AFTER}\n`);
    expect(procStartMs(124, proc)).toBe(123_450);
  });

  it("is null for a pid that is gone, and for a stat it cannot parse", () => {
    expect(procStartMs(999, proc)).toBeNull();
    stat(125, "125 (x) S 1\n");
    expect(procStartMs(125, proc)).toBeNull();
  });
});

describe.skipIf(process.platform !== "linux")("processStartMs on Linux", () => {
  it("is the /proc reading, and is steady across reads", () => {
    const first = processStartMs(process.pid);
    expect(first).not.toBeNull();
    expect(first).toBe(procStartMs(process.pid));
    expect(processStartMs(process.pid)).toBe(first);
  });
});

/**
 * #570 r14e (H1), #581 cp2: a start time is compared exactly on every platform. A window only
 * lets a recycled pid read as the same process, and a comparison that authorises a signal gets none.
 */
describe("sameStart", () => {
  it("compares Linux /proc start times exactly: the next tick is another process", () => {
    expect(sameStart(10_000, 10_000)).toBe(true);
    expect(sameStart(10_000, 10_010)).toBe(false);
    expect(sameStart(10_010, 10_000)).toBe(false);
    expect(sameStart(10_000, 11_000)).toBe(false);
  });

  it("compares `ps -o lstart=` start times exactly too: one or two seconds later is another process", () => {
    expect(sameStart(1_760_000_000_000, 1_760_000_000_000)).toBe(true);
    expect(sameStart(1_760_000_000_000, 1_760_000_001_000)).toBe(false);
    expect(sameStart(1_760_000_000_000, 1_760_000_002_000)).toBe(false);
    expect(sameStart(1_760_000_002_000, 1_760_000_000_000)).toBe(false);
  });
});

describe("pidIdentity (the numeric projection) is exact on every platform", () => {
  const exists = () => true;
  const readAt = (ms: number) => () => ms;

  it("calls a pid whose start moved by one tick (Linux), one microsecond (macOS), one second or two seconds recycled", () => {
    // macOS start times are libproc's, to the microsecond: epoch ms with a fractional part.
    const cases = [
      { platform: "linux", base: 10_000, moves: [10, 1_000, 2_000] },
      { platform: "darwin", base: 1_793_106_335_845.98, moves: [0.001, 1_000, 2_000] },
    ] as const;
    for (const { platform, base, moves } of cases) {
      for (const moved of moves) {
        expect(
          withPlatform(platform, () =>
            pidIdentity(4242, base, { exists, read: readAt(base + moved) }),
          ),
        ).toBe("recycled");
      }
      expect(
        withPlatform(platform, () => pidIdentity(4242, base, { exists, read: readAt(base) })),
      ).toBe("same");
    }
  });

  it("macOS: a whole-second start an older daemon recorded is unknown against a reading in that second, never the same", () => {
    // Before #581 macOS start times came from `ps lstart`, whole seconds. A reading now in the same
    // second cannot tell the recorded process from a stranger born in that second (#596's rule).
    const legacy = 1_793_106_335_000;
    const read = readAt(1_793_106_335_845.98);
    expect(withPlatform("darwin", () => pidIdentity(4242, legacy, { exists, read }))).toBe(
      "unknown",
    );
    // Another second is another process, as before.
    expect(
      withPlatform("darwin", () =>
        pidIdentity(4242, legacy, { exists, read: readAt(legacy + 1_000.5) }),
      ),
    ).toBe("recycled");
    // Linux start times are often whole seconds too, and are exact: never read as a legacy record.
    expect(
      withPlatform("linux", () => pidIdentity(4242, 10_000, { exists, read: readAt(10_010) })),
    ).toBe("recycled");
  });

  it("cannot tell a stranger from the leader when either start time is unknown", () => {
    expect(pidIdentity(4242, null, { exists, read: readAt(10_000) })).toBe("unknown");
    expect(pidIdentity(4242, 10_000, { exists, read: () => null })).toBe("unknown");
    expect(pidIdentity(4242, 10_000, { exists: () => false, read: readAt(10_000) })).toBe("gone");
  });
});

/**
 * #581 cp2: `readPidIdentity` is the one OS reader. These pin what it reads (the raw value, not a
 * derived one), that two reads of one process are identical, and that a process born one tick
 * (Linux) or one second (macOS) later is a different identity.
 */
describe("readPidIdentity (the one reader)", () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), "fake-proc-"));
  });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  const statWithTicks = (pid: number, ticks: string, comm = "sleep"): void => {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    writeFileSync(
      join(proc, String(pid), "stat"),
      `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 4194304 100 0 0 0 5 6 0 0 20 0 1 0 ${ticks} 99999 8888\n`,
    );
  };
  const linux = (): { platform: string; procDir: string } => ({ platform: "linux", procDir: proc });

  it("Linux: the raw start ticks, as read, not milliseconds", () => {
    statWithTicks(123, "12345");
    expect(readPidIdentity(123, linux())).toBe("12345");
    expect(readPidIdentity(123, linux())).toBe("12345"); // steady across reads
  });

  it("Linux: a command name with spaces and parentheses does not move the field", () => {
    statWithTicks(124, "12345", "a) b) (c d");
    expect(readPidIdentity(124, linux())).toBe("12345");
  });

  it("Linux: a process born in the next tick is a different identity, and so is its numeric start", () => {
    statWithTicks(200, "500000");
    statWithTicks(201, "500001"); // the same second, 10 ms later
    const a = readPidIdentity(200, linux());
    const b = readPidIdentity(201, linux());
    expect(sameIdentity(a, a)).toBe(true);
    expect(sameIdentity(a, b)).toBe(false);
    const aMs = startMsFromIdentity(a, "linux");
    const bMs = startMsFromIdentity(b, "linux");
    expect(aMs).toBe(5_000_000);
    expect(bMs).toBe(5_000_010);
    expect(sameStart(aMs as number, bMs as number)).toBe(false);
  });

  it("Linux: nothing is read from a gone pid, a short stat, a non-numeric field, or a pid that names no process", () => {
    expect(readPidIdentity(999, linux())).toBeNull();
    mkdirSync(join(proc, "125"));
    writeFileSync(join(proc, "125", "stat"), "125 (x) S 1\n");
    expect(readPidIdentity(125, linux())).toBeNull();
    statWithTicks(126, "12x45");
    expect(readPidIdentity(126, linux())).toBeNull();
    statWithTicks(127, "");
    expect(readPidIdentity(127, linux())).toBeNull();
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(readPidIdentity(bad, linux())).toBeNull();
  });

  it("macOS: libproc's start time to the microsecond, `<sec>.<usec>`", () => {
    const bsdInfo = (pid: number) => (pid === 42 ? info(42, 1_793_106_335, 5_980) : null);
    expect(readPidIdentity(42, { platform: "darwin", bsdInfo })).toBe("1793106335.005980");
    expect(readPidIdentity(43, { platform: "darwin", bsdInfo })).toBeNull();
  });

  it("macOS: a process born one microsecond later, in the same second, is a different identity", () => {
    // Fault (site: `darwinIdentity`, microseconds dropped): both read "1793106335" and match.
    const starts: Record<number, number> = { 1: 845_980, 2: 845_981 };
    const bsdInfo = (pid: number) =>
      starts[pid] === undefined ? null : info(pid, 1_793_106_335, starts[pid] as number);
    const a = readPidIdentity(1, { platform: "darwin", bsdInfo });
    const b = readPidIdentity(2, { platform: "darwin", bsdInfo });
    expect(sameIdentity(a, b)).toBe(false);
    const aMs = startMsFromIdentity(a, "darwin");
    const bMs = startMsFromIdentity(b, "darwin");
    expect(aMs).toBe(1_793_106_335_845.98);
    expect(bMs).toBe(1_793_106_335_845.981);
    expect(sameStart(aMs as number, bMs as number)).toBe(false);
  });

  it("Windows reads nothing", () => {
    expect(readPidIdentity(42, { platform: "win32", bsdInfo: () => info(42, 1, 0) })).toBeNull();
  });

  it("an identity that cannot be read is the same as nothing", () => {
    expect(sameIdentity(null, null)).toBe(false);
    expect(sameIdentity("12345", null)).toBe(false);
    expect(sameIdentity(null, "12345")).toBe(false);
    expect(sameIdentity("12345", "12345")).toBe(true);
  });

  it("the numeric start is only a projection of the raw identity", () => {
    expect(startMsFromIdentity("12345", "linux")).toBe(123_450);
    expect(startMsFromIdentity("not-ticks", "linux")).toBeNull();
    expect(startMsFromIdentity(null, "linux")).toBeNull();
    expect(startMsFromIdentity("Fri Oct 23 10:00:00 2026", "win32")).toBeNull();
    expect(startMsFromIdentity("not a date", "darwin")).toBeNull();
    expect(startMsFromIdentity("1793106335.845980", "darwin")).toBe(1_793_106_335_845.98);
    // An older daemon's `lstart` text still projects, to the whole second.
    expect(startMsFromIdentity("Fri Oct 23 10:00:00 2026", "darwin")).toBe(
      Date.parse("Fri Oct 23 10:00:00 2026"),
    );
  });

  it("procStartMs and processStartMs read through it", () => {
    statWithTicks(300, "12345");
    expect(procStartMs(300, proc)).toBe(123_450);
    expect(processStartMs(300, linux())).toBe(123_450);
  });

  it.skipIf(process.platform !== "darwin")(
    "macOS, real libproc: steady across reads, to the microsecond, and the second `ps` reports",
    () => {
      const first = readPidIdentity(process.pid);
      expect(first).toMatch(/^\d+\.\d{6}$/);
      expect(readPidIdentity(process.pid)).toBe(first);
      // The same birth `ps` reports, to the second it can see (UTC, so no zone is guessed).
      const lstart = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], {
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      })
        .toString()
        .trim();
      expect(Number(first?.split(".")[0])).toBe(Date.parse(`${lstart} UTC`) / 1000);
      // And the group id libproc reads is the one `ps` reports.
      const pgid = Number(
        execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)])
          .toString()
          .trim(),
      );
      expect(readPidSnapshot(process.pid)).toEqual({ identity: first as string, pgid });
    },
  );

  it.skipIf(process.platform !== "linux")("Linux, real /proc: steady across reads", () => {
    const first = readPidIdentity(process.pid);
    expect(first).toMatch(/^\d+$/);
    expect(readPidIdentity(process.pid)).toBe(first);
  });
});

// #570 r15 (A1): Linux start times count from boot, so a persisted one is comparable only on the
// boot that wrote it. The boot id is stored beside it and checked first.
describe("recordedOnAnotherBoot", () => {
  const boot = (id: string | null) => ({ platform: "linux", bootId: () => id });

  it("same boot id: not another boot", () => {
    expect(recordedOnAnotherBoot("boot-A", boot("boot-A"))).toBe(false);
  });

  it("different boot id: another boot", () => {
    expect(recordedOnAnotherBoot("boot-A", boot("boot-B"))).toBe(true);
  });

  it("a Linux record with no boot id predates the field: another boot", () => {
    expect(recordedOnAnotherBoot(null, boot("boot-B"))).toBe(true);
    expect(recordedOnAnotherBoot(undefined, boot("boot-B"))).toBe(true);
  });

  it("this boot's id unreadable: nothing can be shown to differ", () => {
    expect(recordedOnAnotherBoot("boot-A", boot(null))).toBe(false);
    expect(recordedOnAnotherBoot(null, boot(null))).toBe(false);
  });

  it("off Linux there is no boot id to compare (ps lstart is epoch time)", () => {
    for (const platform of ["darwin", "freebsd"]) {
      expect(recordedOnAnotherBoot(null, { platform, bootId: () => "boot-B" })).toBe(false);
      expect(recordedOnAnotherBoot("boot-A", { platform, bootId: () => "boot-B" })).toBe(false);
    }
  });
});

describe("readBootId / currentBootId", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "boot-id-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads the id with its trailing newline removed", () => {
    const file = join(dir, "boot_id");
    writeFileSync(file, "6f1c2f64-0d0a-4a52-9d3b-2a0f6b7c1e11\n");
    expect(readBootId(file)).toBe("6f1c2f64-0d0a-4a52-9d3b-2a0f6b7c1e11");
  });

  it("is null for a missing or empty file", () => {
    expect(readBootId(join(dir, "none"))).toBeNull();
    const empty = join(dir, "empty");
    writeFileSync(empty, "\n");
    expect(readBootId(empty)).toBeNull();
  });

  it("is null off Linux", () => {
    expect(currentBootId("darwin")).toBeNull();
  });
});

// #570 r15b: CLAUDECLAW_TEST_PLATFORM=linux runs the boot-id branch on a Mac. It must change only
// the seam defaults, and only under NODE_ENV=test.
describe("the test-only Linux switch", () => {
  const saved = {
    platform: process.env.CLAUDECLAW_TEST_PLATFORM,
    nodeEnv: process.env.NODE_ENV,
  };
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  afterEach(() => {
    restore("CLAUDECLAW_TEST_PLATFORM", saved.platform);
    restore("NODE_ENV", saved.nodeEnv);
  });

  it("on: the defaults act as Linux with the fixed boot id", () => {
    process.env.NODE_ENV = "test";
    process.env.CLAUDECLAW_TEST_PLATFORM = "linux";
    expect(readBootId()).toBe(TEST_BOOT_ID);
    expect(currentBootId()).toBe(TEST_BOOT_ID);
    expect(recordedOnAnotherBoot(null)).toBe(true); // no boot id: from before the field
    expect(recordedOnAnotherBoot("some-other-boot")).toBe(true);
    expect(recordedOnAnotherBoot(TEST_BOOT_ID)).toBe(false);
  });

  it("on: an explicit path or platform still wins", () => {
    process.env.NODE_ENV = "test";
    process.env.CLAUDECLAW_TEST_PLATFORM = "linux";
    expect(readBootId("/nonexistent/boot_id")).toBeNull();
    expect(currentBootId("darwin")).toBeNull();
    expect(recordedOnAnotherBoot(null, { platform: "darwin" })).toBe(false);
  });

  it("off, or outside NODE_ENV=test: the real platform decides", () => {
    delete process.env.CLAUDECLAW_TEST_PLATFORM;
    expect(currentBootId()).toBe(currentBootId(process.platform));
    // On Linux the line above compares a call with itself; this one fails if the switch leaks.
    expect(currentBootId()).not.toBe(TEST_BOOT_ID);
    process.env.CLAUDECLAW_TEST_PLATFORM = "linux";
    process.env.NODE_ENV = "production";
    expect(readBootId()).not.toBe(TEST_BOOT_ID);
    expect(currentBootId()).not.toBe(TEST_BOOT_ID);
  });
});

// ─── #581 cp8: identity and group id from one reading; the members of a group ──────────

describe("readPidSnapshot and readGroupMembers (#581 cp8)", () => {
  let proc: string;
  beforeEach(() => {
    proc = mkdtempSync(join(tmpdir(), "fake-proc-"));
  });
  afterEach(() => rmSync(proc, { recursive: true, force: true }));

  // Fields after the command: state, ppid, pgrp, ... starttime is the 20th (field 22 overall).
  const stat = (pid: number, state: string, pgrp: number, ticks: number): void => {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(
      join(proc, String(pid), "stat"),
      `${pid} (a b) ${state} 1 ${pgrp} ${pgrp} 0 -1 4194304 100 0 0 0 5 6 0 0 20 0 1 0 ${ticks} 99999 8888\n`,
    );
  };
  const linux = { platform: "linux", procDir: "" };

  it("reads the identity and the group id from the same /proc/<pid>/stat", () => {
    stat(123, "S", 77, 12345);
    expect(readPidSnapshot(123, { ...linux, procDir: proc })).toEqual({
      identity: "12345",
      pgid: 77,
    });
    // The identity is the one readPidIdentity reports: one reading, one meaning.
    expect(readPidIdentity(123, { ...linux, procDir: proc })).toBe("12345");
  });

  it("is null for a pid that is gone, a malformed stat, and platforms that cannot say", () => {
    expect(readPidSnapshot(999, { ...linux, procDir: proc })).toBeNull();
    mkdirSync(join(proc, "5"));
    writeFileSync(join(proc, "5", "stat"), "5 (x) S garbage\n");
    expect(readPidSnapshot(5, { ...linux, procDir: proc })).toBeNull();
    expect(readPidSnapshot(123, { platform: "win32" })).toBeNull();
    expect(readPidSnapshot(0, { ...linux, procDir: proc })).toBeNull();
  });

  it("reads the identity and the group id from one libproc reading on macOS", () => {
    const bsdInfo = () => info(4242, 1_793_106_335, 845_980, 4200);
    expect(readPidSnapshot(4242, { platform: "darwin", bsdInfo })).toEqual({
      identity: "1793106335.845980",
      pgid: 4200,
    });
    expect(readPidSnapshot(4242, { platform: "darwin", bsdInfo: () => null })).toBeNull();
  });

  it("lists the live members of a group with their identities, not zombies or other groups", () => {
    stat(100, "S", 100, 1000); // the leader
    stat(101, "S", 100, 1010); // a member
    stat(102, "Z", 100, 1020); // a zombie of the group
    stat(103, "S", 200, 1030); // another group
    const reading = readGroupMembers(100, Date.now() + 5000, { ...linux, procDir: proc });
    expect(reading.complete).toBe(true);
    expect(reading.members.sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 100, identity: "1000" },
      { pid: 101, identity: "1010" },
    ]);
  });

  it("says the listing is incomplete when an entry cannot be read, and keeps what it saw", () => {
    stat(100, "S", 100, 1000);
    mkdirSync(join(proc, "104")); // no stat file: ENOENT, a process that went away
    mkdirSync(join(proc, "105"));
    writeFileSync(join(proc, "105", "stat"), "105 (x) S garbage\n"); // present but not understood
    const reading = readGroupMembers(100, Date.now() + 5000, { ...linux, procDir: proc });
    expect(reading.members).toEqual([{ pid: 100, identity: "1000" }]);
    expect(reading.complete).toBe(false);
  });

  it("stops walking /proc once the deadline has passed", () => {
    for (let pid = 200; pid < 330; pid++) stat(pid, "S", 100, pid);
    const reading = readGroupMembers(100, 0, { ...linux, procDir: proc, now: () => 1 });
    expect(reading.complete).toBe(false);
    expect(reading.members.length).toBeLessThan(130);
  });

  it.skipIf(process.platform !== "darwin")(
    "libproc: a failed listing (0, libproc's error value) or a byte count that is not whole pids is no listing (#581 review, M2)",
    () => {
      const pids = new Int32Array([4242, 4243]);
      // The sizing call (no buffer) answers `hint`; the listing call answers `bytes`.
      const answer =
        (bytes: number, hint = 8) =>
        (_type: number, _pgid: number, buf: Uint8Array | null, _size: number): number => {
          if (!buf) return hint;
          buf.set(new Uint8Array(pids.buffer).subarray(0, Math.min(bytes, 8)));
          return bytes;
        };
      // Fault (site: the listing's `!(bytes > 0)` back to `bytes < 0`): 0 lists [], a complete
      // empty group, and a retirement drops the members it knew.
      expect(libprocGroupPids(4242, answer(0))).toBeNull();
      expect(libprocGroupPids(4242, answer(8, 0))).toBeNull(); // the sizing call failed
      expect(libprocGroupPids(4242, answer(5))).toBeNull();
      expect(libprocGroupPids(4242, answer(8))).toEqual([4242, 4243]);
    },
  );

  describe("macOS (libproc)", () => {
    const SEC = 1_793_106_335;
    // The group's pids as libproc lists them, what libproc reads of each, and (for the pids it
    // does not answer) what the kernel's kinfo_proc says.
    const table: Record<number, ReturnType<typeof info> | null> = {
      100: info(100, SEC, 1, 100), // the leader
      101: info(101, SEC, 2, 100), // a member
      103: info(103, SEC, 3, 300), // listed, but its own reading puts it in another group now
    };
    const kinfoTable: Record<number, KinfoProc | "gone" | null> = {
      104: "gone", // gone since the listing
      105: { pid: 105, zombie: true, pgid: 100, start: { sec: SEC, usec: 5 } }, // a zombie
      106: { pid: 106, zombie: false, pgid: 100, start: { sec: SEC, usec: 6 } }, // libproc would not say
    };
    const deps = (over: Partial<IdentityReadDeps> = {}) => ({
      platform: "darwin",
      groupPids: () => [100, 101, 103, 104, 105, 106],
      bsdInfo: (pid: number) => table[pid] ?? null,
      kinfo: (pid: number) => kinfoTable[pid] ?? null,
      ...over,
    });

    it("lists the live members with their identities: not zombies, the gone, or other groups", () => {
      const reading = readGroupMembers(100, Date.now() + 5000, deps());
      expect(reading).toEqual({
        members: [
          { pid: 100, identity: `${SEC}.000001` },
          { pid: 101, identity: `${SEC}.000002` },
          { pid: 106, identity: `${SEC}.000006` },
        ],
        complete: true,
      });
    });

    it("is incomplete when a listed pid cannot be read at all", () => {
      // Fault (site: the unreadable branch, `complete = false` dropped): this reads complete, and a
      // retirement would take a member it could not see as positive absence.
      const reading = readGroupMembers(100, Date.now() + 5000, deps({ kinfo: () => null }));
      expect(reading.complete).toBe(false);
      expect(reading.members.map((m) => m.pid)).toEqual([100, 101]); // what it saw is kept
    });

    it("a zombie still holds its pid, so it keeps the identity it was born with", () => {
      // libproc does not answer for a zombie. A leader that has exited but is not yet reaped is
      // still the process recorded at spawn, and must read so: a retirement that took it as
      // unknown withheld the group's SIGTERM (#581 decision 2, seen in pty-group-retire).
      const zombie = deps({ bsdInfo: () => null });
      expect(readPidIdentity(105, zombie)).toBe(`${SEC}.000005`);
      expect(readPidSnapshot(105, zombie)).toEqual({ identity: `${SEC}.000005`, pgid: 100 });
      expect(readPidIdentity(104, zombie)).toBeNull(); // gone
    });

    it("is incomplete when the group cannot be listed, and starts nothing with no time left", () => {
      expect(readGroupMembers(100, Date.now() + 5000, deps({ groupPids: () => null }))).toEqual({
        members: [],
        complete: false,
      });
      let asked = 0;
      const counting = deps({
        groupPids: () => {
          asked++;
          return [100];
        },
      });
      expect(readGroupMembers(100, 0, { ...counting, now: () => 5 })).toEqual({
        members: [],
        complete: false,
      });
      expect(asked).toBe(0);
    });
  });

  it.skipIf(process.platform !== "darwin")(
    "macOS, real libproc: lists a real group, leaving out a zombie member, as `ps` sees it",
    async () => {
      // A group leader with a live sleeper, and a member whose own child exits unreaped: a zombie
      // in the group whose parent is not the leader (so its parent's pid is not its group's id).
      const leader = spawn(
        "/bin/sh",
        ["-c", "sleep 30 & sh -c '(exit 0) & exec sleep 30' & exec sleep 30"],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      try {
        await Bun.sleep(400);
        const pgid = leader.pid as number;
        const rows = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,stat="])
          .toString()
          .split("\n")
          .map((l) => l.trim().split(/\s+/))
          .filter((f) => Number(f[1]) === pgid);
        const live = rows.filter((f) => !f[2]?.startsWith("Z")).map((f) => Number(f[0]));
        expect(rows.some((f) => f[2]?.startsWith("Z"))).toBe(true); // the zombie is there
        const reading = readGroupMembers(pgid, Date.now() + 5000);
        expect(reading.complete).toBe(true);
        expect(reading.members.map((m) => m.pid).sort((a, b) => a - b)).toEqual(
          live.sort((a, b) => a - b),
        );
        for (const m of reading.members) expect(m.identity).toBe(readPidIdentity(m.pid) as string);
        // The zombie itself still has its identity and group, through the kernel's kinfo_proc.
        const zombie = Number(rows.find((f) => f[2]?.startsWith("Z"))?.[0]);
        const zombieParent = Number(
          execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(zombie)])
            .toString()
            .trim(),
        );
        expect(zombieParent).not.toBe(pgid);
        const lstart = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(zombie)], {
          env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        })
          .toString()
          .trim();
        const snap = readPidSnapshot(zombie);
        expect(snap?.identity).toMatch(/^\d+\.\d{6}$/);
        expect(Number(snap?.identity.split(".")[0])).toBe(Date.parse(`${lstart} UTC`) / 1000);
        expect(snap?.pgid).toBe(pgid);
      } finally {
        try {
          process.kill(-(leader.pid as number), "SIGKILL");
        } catch {}
      }
    },
  );
});

/**
 * #581 (decision 2, after #596): an identity or start time read now against a recorded one.
 * A second-precise record (an older macOS daemon's `ps lstart`) that matches to the second is
 * `unknown`: it never authorises a signal, and it is not proof that the process is gone either.
 */
describe("compareIdentity / compareStartMs", () => {
  it("same only when both were read and are equal; a missing reading cannot tell", () => {
    for (const platform of ["linux", "darwin"]) {
      expect(compareIdentity("1793106335.845980", "1793106335.845980", platform)).toBe("same");
      expect(compareIdentity(null, "1793106335.845980", platform)).toBe("unknown");
      expect(compareIdentity("1793106335.845980", null, platform)).toBe("unknown");
      expect(compareStartMs(1_793_106_335_845.98, 1_793_106_335_845.98, platform)).toBe("same");
      expect(compareStartMs(null, 10_000, platform)).toBe("unknown");
      expect(compareStartMs(10_000, null, platform)).toBe("unknown");
    }
    expect(compareStartMs(10_000, 10_000, "linux")).toBe("same");
  });

  it("macOS: `lstart` text equal to the reading is unknown, never the same (#581 review, M1)", () => {
    // Fault (site: the equality checked before the precision rule): "same", so an older daemon's
    // record would vouch for a process born later in that second.
    const lstart = "Tue Oct 27 13:05:35 2026";
    expect(compareIdentity(lstart, lstart, "darwin")).toBe("unknown");
    // Opaque values (no `lstart` shape) compare exactly, as two libproc readings do.
    expect(compareIdentity("boot-1", "boot-1", "darwin")).toBe("same");
    expect(compareIdentity("boot-1", "boot-2", "darwin")).toBe("different");
  });

  it("macOS: libproc's reading against an older daemon's `lstart` text of the same second is unknown", () => {
    const lstart = "Tue Oct 27 13:05:35 2026";
    const sec = Date.parse(lstart) / 1000; // the zone `ps` printed it in, as the old reader parsed it
    // Fault (site: `compareIdentity`, the second-precise branch removed): this reads "different",
    // and a survivor record from before the upgrade would take its live leader as recycled.
    expect(compareIdentity(`${sec}.845980`, lstart, "darwin")).toBe("unknown");
    expect(compareIdentity(lstart, `${sec}.845980`, "darwin")).toBe("unknown");
    // Another second is another process; two precise readings are compared exactly.
    expect(compareIdentity(`${sec + 1}.000000`, lstart, "darwin")).toBe("different");
    expect(compareIdentity(`${sec}.845980`, `${sec}.845981`, "darwin")).toBe("different");
    // Linux identities are exact ticks: never read as second-precise.
    expect(compareIdentity("12345", "12346", "linux")).toBe("different");
  });

  it("macOS: a whole-second start time against a reading in that second is unknown; Linux stays exact", () => {
    const legacy = 1_793_106_335_000;
    // Fault (site: `compareStartMs`, the whole-second branch removed): "different", so a live owner
    // recorded by an older daemon reads as dead and its directories are swept.
    expect(compareStartMs(legacy + 845.98, legacy, "darwin")).toBe("unknown");
    expect(compareStartMs(legacy + 1_000.5, legacy, "darwin")).toBe("different");
    expect(compareStartMs(legacy + 845.98, legacy + 845.981, "darwin")).toBe("different");
    expect(compareStartMs(10_010, 10_000, "linux")).toBe("different");
  });
});

describe("noteGroupMembers (#581 cp8)", () => {
  const base = {
    pid: 5150,
    identity: "id-1",
    groupId: 5150,
    members: [] as { pid: number; identity: string }[],
    daemonGroupId: 4000,
    readGroupId: () => 5150,
    readMembers: () => ({ members: [{ pid: 9001, identity: "m1" }], complete: true }),
  };
  const alive = () => {};
  const gone = () => {
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  };

  it("learns the members of a group whose leader is the recorded process", () => {
    const out = noteGroupMembers({ ...base, signal: alive, readIdentity: () => "id-1" });
    expect(out.members).toEqual([{ pid: 9001, identity: "m1" }]);
  });

  it("learns nothing from an absent leader that nothing known vouches for", () => {
    expect(noteGroupMembers({ ...base, signal: gone, readIdentity: () => null }).members).toEqual(
      [],
    );
    // A member identified earlier that the listing does not show vouches for nothing either.
    const had = [{ pid: 9000, identity: "m0" }];
    expect(
      noteGroupMembers({ ...base, members: had, signal: gone, readIdentity: () => null }).members,
    ).toEqual(had);
  });

  it("learns nothing from an absent leader, even while a member identified earlier is still in the group (cp10)", () => {
    const had = [{ pid: 9001, identity: "m1" }];
    const out = noteGroupMembers({
      ...base,
      members: had,
      signal: gone,
      readIdentity: () => null,
      readMembers: () => ({
        members: [
          { pid: 9001, identity: "m1" },
          { pid: 9002, identity: "m2" },
        ],
        complete: true,
      }),
    });
    // Option B, strict: members are learned only while the leader is the recorded process.
    expect(out.members).toEqual(had);
  });

  it("learns nothing when the leader is no longer the recorded process after the listing (cp10, H2)", () => {
    let reads = 0;
    const out = noteGroupMembers({
      ...base,
      signal: alive,
      // Ours before the listing, a stranger's after it: the leader exited and its pid was reused.
      readIdentity: () => (reads++ === 0 ? "id-1" : "other"),
    });
    expect(out.members).toEqual([]);
  });

  it("learns nothing when the pid is another process's or cannot be read", () => {
    for (const read of [() => "other", () => null]) {
      const out = noteGroupMembers({ ...base, signal: alive, readIdentity: read });
      expect(out.members).toEqual([]);
    }
  });

  it("learns nothing from a group that is not isolated", () => {
    const shared = noteGroupMembers({
      ...base,
      signal: alive,
      readIdentity: () => "id-1",
      readGroupId: () => 777,
      groupId: 777,
    });
    expect(shared.members).toEqual([]);
    const daemons = noteGroupMembers({
      ...base,
      signal: alive,
      readIdentity: () => "id-1",
      daemonGroupId: 5150,
    });
    expect(daemons.members).toEqual([]);
  });

  it("adds to what it already has, and a failing listing changes nothing", () => {
    const had = [{ pid: 9000, identity: "m0" }];
    const added = noteGroupMembers({
      ...base,
      members: had,
      signal: alive,
      readIdentity: () => "id-1",
    });
    expect(added.members).toEqual([...had, { pid: 9001, identity: "m1" }]);
    const failed = noteGroupMembers({
      ...base,
      members: had,
      signal: alive,
      readIdentity: () => "id-1",
      readMembers: () => {
        throw new Error("boom");
      },
    });
    expect(failed.members).toEqual(had);
  });
});
