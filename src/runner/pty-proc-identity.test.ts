import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentBootId,
  pidIdentity,
  procStartMs,
  processStartMs,
  readBootId,
  readPidIdentity,
  recordedOnAnotherBoot,
  sameIdentity,
  sameStart,
  startMsFromIdentity,
  TEST_BOOT_ID,
} from "./pty-proc-identity.js";
import { withPlatform } from "./pty-test-platform.js";

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

  it("calls a pid whose start moved by one tick, one second or two seconds recycled", () => {
    for (const platform of ["linux", "darwin"] as const) {
      for (const moved of [10, 1_000, 2_000]) {
        expect(
          withPlatform(platform, () =>
            pidIdentity(4242, 10_000, { exists, read: readAt(10_000 + moved) }),
          ),
        ).toBe("recycled");
      }
      expect(
        withPlatform(platform, () => pidIdentity(4242, 10_000, { exists, read: readAt(10_000) })),
      ).toBe("same");
    }
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

  it("macOS: the C-locale `lstart` text exactly as `ps` printed it", () => {
    const ps = (pid: number): string | null => (pid === 42 ? "Fri Oct 23 10:00:00 2026" : null);
    expect(readPidIdentity(42, { platform: "darwin", ps })).toBe("Fri Oct 23 10:00:00 2026");
    expect(readPidIdentity(43, { platform: "darwin", ps })).toBeNull();
  });

  it("macOS: a process born one second later is a different identity, and so is its numeric start", () => {
    const text: Record<number, string> = {
      1: "Fri Oct 23 10:00:00 2026",
      2: "Fri Oct 23 10:00:01 2026",
    };
    const ps = (pid: number): string | null => text[pid] ?? null;
    const a = readPidIdentity(1, { platform: "darwin", ps });
    const b = readPidIdentity(2, { platform: "darwin", ps });
    expect(sameIdentity(a, b)).toBe(false);
    const aMs = startMsFromIdentity(a, "darwin");
    const bMs = startMsFromIdentity(b, "darwin");
    expect(aMs).not.toBeNull();
    expect((bMs as number) - (aMs as number)).toBe(1_000);
    expect(sameStart(aMs as number, bMs as number)).toBe(false);
  });

  it("Windows reads nothing", () => {
    expect(readPidIdentity(42, { platform: "win32", ps: () => "x" })).toBeNull();
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
  });

  it("procStartMs and processStartMs read through it", () => {
    statWithTicks(300, "12345");
    expect(procStartMs(300, proc)).toBe(123_450);
    expect(processStartMs(300, linux())).toBe(123_450);
  });

  it.skipIf(process.platform !== "darwin")(
    "macOS, real `ps`: steady across reads and unaffected by the caller's locale",
    () => {
      const first = readPidIdentity(process.pid);
      expect(first).not.toBeNull();
      expect(readPidIdentity(process.pid)).toBe(first);
      expect(first).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9]\d \d\d:\d\d:\d\d \d{4}$/);
      const saved = process.env.LC_ALL;
      process.env.LC_ALL = "fr_FR.UTF-8";
      try {
        expect(readPidIdentity(process.pid)).toBe(first);
      } finally {
        if (saved === undefined) delete process.env.LC_ALL;
        else process.env.LC_ALL = saved;
      }
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
