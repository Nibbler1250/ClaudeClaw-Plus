import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidIdentity, procStartMs, processStartMs, sameStart } from "./pty-proc-identity.js";
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

/** #570 r14e (H1): a `/proc` start time is exact, so any window only lets a recycled pid read as the same. */
describe("sameStart", () => {
  it("compares Linux /proc start times exactly: the next tick is another process", () => {
    expect(sameStart(10_000, 10_000, "linux")).toBe(true);
    // Went red (true) with `<= 10` put back on the Linux path.
    expect(sameStart(10_000, 10_010, "linux")).toBe(false);
    expect(sameStart(10_010, 10_000, "linux")).toBe(false);
    expect(sameStart(10_000, 11_000, "linux")).toBe(false);
  });

  it("keeps 2 s for `ps -o lstart=`, which has one-second resolution", () => {
    expect(sameStart(10_000, 11_000, "darwin")).toBe(true);
    expect(sameStart(10_000, 12_001, "darwin")).toBe(false);
  });

  it("takes the platform from the process by default", () => {
    expect(withPlatform("linux", () => sameStart(10_000, 11_000))).toBe(false);
    expect(withPlatform("darwin", () => sameStart(10_000, 11_000))).toBe(true);
  });
});

describe("pidIdentity on Linux", () => {
  const exists = () => true;
  it("calls a pid whose start moved by one second recycled", () => {
    const read = () => 11_000;
    expect(withPlatform("linux", () => pidIdentity(4242, 10_000, { exists, read }))).toBe(
      "recycled",
    );
    expect(withPlatform("darwin", () => pidIdentity(4242, 10_000, { exists, read }))).toBe("same");
  });
});
