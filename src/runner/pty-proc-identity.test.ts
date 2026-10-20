import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { procStartMs, processStartMs } from "./pty-proc-identity.js";

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
