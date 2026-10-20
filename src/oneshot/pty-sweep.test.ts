import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_INSTANCE,
  ONESHOT_CONFIG_PREFIX,
  ONESHOT_CWD_PREFIX,
  ONESHOT_OWNER_FILE,
  ONESHOT_SWEEP_INTERVAL_MS,
  ONESHOT_SWEEP_MAX_AGE_MS,
  type OwnerRecord,
  createUntrustedConfigRoot,
  createUntrustedTempCwd,
  groupSurvivorOf,
  markGroupSurvivor,
  markOneShotDirActive,
  operatorSecureStorageDir,
  processStartMs,
  releaseOneShotDir,
  resetOneShotSweeperForTests,
  startOneShotSweeper,
  sweepStaleOneShotDirs,
} from "./pty-cleanup.js";

/**
 * #570 r12 (B): the sweep never removes a live call's directories; (F2): secure-storage resolution.
 *
 * Each assertion below went red under its own one-site fault (see the r12 section of the #570
 * report): owner check removed or inverted, ESRCH and reused-pid reads, unknown start time, the
 * uid, age and active-call guards, the fallback for a missing owner file, the timer's
 * registration, unref, interval and error handling, the two owner-file writes, and each
 * daemon-env fallback.
 */

const NOW = Date.now();
const OLD = (NOW - ONESHOT_SWEEP_MAX_AGE_MS - 60_000) / 1000;
const YOUNG = (NOW - 60_000) / 1000;
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sweep-test-"));
});
afterEach(() => {
  resetOneShotSweeperForTests();
  rmSync(base, { recursive: true, force: true });
});

function leftover(name: string, mtime: number, owner?: OwnerRecord | "garbage"): string {
  const path = join(base, name);
  mkdirSync(path);
  writeFileSync(join(path, "prompt.jsonl"), "PROMPT_TEXT");
  if (owner === "garbage") writeFileSync(join(path, ONESHOT_OWNER_FILE), "{not json");
  else if (owner) writeFileSync(join(path, ONESHOT_OWNER_FILE), JSON.stringify(owner));
  utimesSync(path, mtime, mtime);
  return path;
}

const sweep = (deps: Parameters<typeof sweepStaleOneShotDirs>[3] = {}): number =>
  sweepStaleOneShotDirs(base, NOW, ONESHOT_SWEEP_MAX_AGE_MS, deps);

/** A pid that existed and is gone. */
function deadPid(): number {
  const child = spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(child.stdout.trim());
}

const selfStart = processStartMs(process.pid);
const live = (over: Partial<OwnerRecord> = {}): OwnerRecord => ({
  pid: process.pid,
  startMs: selfStart,
  instance: "another-daemon",
  ...over,
});

describe("sweepStaleOneShotDirs: who may be removed", () => {
  it("keeps an old directory whose owner is still running", () => {
    const path = leftover(`${ONESHOT_CONFIG_PREFIX}live`, OLD, live());
    expect(sweep()).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("removes an old directory whose owner is dead", () => {
    const path = leftover(`${ONESHOT_CONFIG_PREFIX}dead`, OLD, live({ pid: deadPid() }));
    expect(sweep()).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it("removes one whose pid now belongs to a process that started later", () => {
    const path = leftover(
      `${ONESHOT_CWD_PREFIX}reused`,
      OLD,
      live({ startMs: NOW - 90 * 86_400_000 }),
    );
    expect(sweep()).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it("keeps one when the owner's start time cannot be compared", () => {
    const path = leftover(`${ONESHOT_CWD_PREFIX}unknown`, OLD, live({ startMs: null }));
    expect(sweep()).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("skips a directory owned by another uid, whatever its owner file says", () => {
    const path = leftover(`${ONESHOT_CONFIG_PREFIX}foreign`, OLD, live({ pid: deadPid() }));
    expect(sweep({ uid: statSync(path).uid + 1 })).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("keeps a young directory even when its owner is dead", () => {
    const path = leftover(`${ONESHOT_CONFIG_PREFIX}young`, YOUNG, live({ pid: deadPid() }));
    expect(sweep()).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it("falls back to the age rule without a readable owner file", () => {
    const none = leftover(`${ONESHOT_CONFIG_PREFIX}none`, OLD);
    const broken = leftover(`${ONESHOT_CWD_PREFIX}broken`, OLD, "garbage");
    const young = leftover(`${ONESHOT_CWD_PREFIX}young-none`, YOUNG);
    expect(sweep()).toBe(2);
    expect(existsSync(none)).toBe(false);
    expect(existsSync(broken)).toBe(false);
    expect(existsSync(young)).toBe(true);
  });

  it("keeps a call of this daemon that is still running, and removes one it has finished with", () => {
    const own = live({ pid: process.pid, instance: DAEMON_INSTANCE });
    const running = leftover(`${ONESHOT_CONFIG_PREFIX}running`, OLD, own);
    const failed = leftover(`${ONESHOT_CONFIG_PREFIX}failed`, OLD, own);
    markOneShotDirActive(running);
    try {
      expect(sweep()).toBe(1);
    } finally {
      releaseOneShotDir(running);
    }
    expect(existsSync(running)).toBe(true);
    expect(existsSync(failed)).toBe(false);
  });

  it("leaves symlinks and plain files with the prefix alone", () => {
    const target = join(base, "target");
    mkdirSync(target);
    utimesSync(target, OLD, OLD);
    symlinkSync(target, join(base, `${ONESHOT_CONFIG_PREFIX}link`));
    writeFileSync(join(base, `${ONESHOT_CWD_PREFIX}file`), "x");
    utimesSync(join(base, `${ONESHOT_CWD_PREFIX}file`), OLD, OLD);
    expect(sweep()).toBe(0);
    expect(existsSync(target)).toBe(true);
  });
});

describe("owner files", () => {
  it("are written into the config root and the temp cwd when they are created", () => {
    const cwd = createUntrustedTempCwd();
    const root = createUntrustedConfigRoot([cwd]);
    try {
      for (const dir of [cwd, root]) {
        const owner = JSON.parse(
          readFileSync(join(dir, ONESHOT_OWNER_FILE), "utf8"),
        ) as OwnerRecord;
        expect(owner.pid).toBe(process.pid);
        expect(owner.instance).toBe(DAEMON_INSTANCE);
        expect(statSync(join(dir, ONESHOT_OWNER_FILE)).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("startOneShotSweeper", () => {
  it("sweeps now and registers one unref'd 10-minute timer, however often it is called", () => {
    const registered: number[] = [];
    let unrefs = 0;
    let passes = 0;
    let tick: (() => void) | undefined;
    const deps = {
      sweep: () => ++passes,
      setInterval: (callback: () => void, ms: number) => {
        registered.push(ms);
        tick = callback;
        return { unref: () => void unrefs++ };
      },
    };
    expect(startOneShotSweeper(deps)).toBe(1);
    startOneShotSweeper(deps);
    expect(registered).toEqual([ONESHOT_SWEEP_INTERVAL_MS]);
    expect(ONESHOT_SWEEP_INTERVAL_MS).toBe(10 * 60_000);
    expect(unrefs).toBe(1);
    tick?.();
    expect(passes).toBe(3); // two starts and one timer tick
  });

  it("survives a pass that throws, so the next tick still runs", () => {
    let tick: (() => void) | undefined;
    let passes = 0;
    startOneShotSweeper({
      sweep: () => {
        passes++;
        if (passes === 2) throw new Error("boom");
        return 0;
      },
      setInterval: (callback) => {
        tick = callback;
        return {};
      },
    });
    expect(() => tick?.()).not.toThrow();
    tick?.();
    expect(passes).toBe(3);
  });
});

describe("operatorSecureStorageDir with the daemon's own env", () => {
  it("takes the operator's CLAUDE_CONFIG_DIR from the daemon when print's policy env lacks it", () => {
    expect(
      operatorSecureStorageDir({ PATH: "/usr/bin" }, { CLAUDE_CONFIG_DIR: "/home/op/claude" }),
    ).toBe("/home/op/claude");
  });

  it("lets the policy env win over the daemon's", () => {
    expect(
      operatorSecureStorageDir(
        { CLAUDE_CONFIG_DIR: "/policy/dir" },
        { CLAUDE_CONFIG_DIR: "/home/op/claude" },
      ),
    ).toBe("/policy/dir");
    expect(
      operatorSecureStorageDir(
        { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/policy/store" },
        { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/daemon/store", CLAUDE_CONFIG_DIR: "/home/op/claude" },
      ),
    ).toBe("/policy/store");
  });

  it("takes an explicit CLAUDE_SECURESTORAGE_CONFIG_DIR from the daemon too", () => {
    expect(operatorSecureStorageDir({}, { CLAUDE_SECURESTORAGE_CONFIG_DIR: "/daemon/store" })).toBe(
      "/daemon/store",
    );
  });

  it("is the default store ('') when neither env names a directory", () => {
    expect(operatorSecureStorageDir({}, {})).toBe("");
  });

  it("fails closed on a relative directory from the daemon env", () => {
    expect(() => operatorSecureStorageDir({}, { CLAUDE_CONFIG_DIR: "relative/dir" })).toThrow(
      /absolute/,
    );
  });
});

describe("group survivors", () => {
  it("are recorded per root", () => {
    markGroupSurvivor("/tmp/root-a", 4242);
    expect(groupSurvivorOf("/tmp/root-a")).toBe(4242);
    expect(groupSurvivorOf("/tmp/root-b")).toBeUndefined();
  });
});
