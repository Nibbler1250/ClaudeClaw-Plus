import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests, loadSettings } from "../config.js";
import { PtyExitUnconfirmedError, type PtyProcessOptions } from "../runner/pty-process.js";
import { quarantineSnapshot } from "../runner/pty-quarantine.js";
import {
  __resetSupervisorForTests,
  injectPendingSpawnWait,
  injectSpawnPty,
  killAllPtys,
  runOnceOnPty,
} from "../runner/pty-supervisor.js";
import * as cleanup from "./pty-cleanup.js";
import { withPrintRuntime } from "./print.js";
import { engines } from "./registry.js";

/**
 * #581 cp5: an isolated one-shot whose claude lands AFTER the call handed back. The root is
 * removed, and the slot freed, only once that child's exit is confirmed. A failed or unknown
 * disposal keeps both (with the session quarantined); the 60 s ceiling only logs; a spawn that
 * never settled (the #592 stand-in, pid 0) holds them too.
 */

let dir: string;
let savedConfig: string | undefined;
let savedIsolation: boolean;
let warned: string[];
let warn: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
let roots: string[];

const SID = "11111111-2222-3333-4444-555555555555";
const LATE_PID = 5252;
const LATE_START_MS = 1_700_000_000_001;
const CEILING_LINE = "one-shot slot held past ceiling: retirement pending";

const request = {
  route: "discord.classifier",
  prompt: "classify this",
  isolation: "untrusted" as const,
  timeoutMs: 2000,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const stop = Date.now() + ms;
  while (!cond() && Date.now() < stop) await sleep(5);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pty-late-retire-"));
  savedConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(dir, "parent-config");
  const file = join(dir, "settings.json");
  writeFileSync(file, "{}");
  _setSettingsFileForTests(file);
  await loadSettings();
  savedIsolation = engines.get("pty")!.caps.isolation;
  engines.get("pty")!.caps.isolation = true;
  warned = [];
  roots = [];
  warn = spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    warned.push(String(a[0]));
  });
  error = spyOn(console, "error").mockImplementation(() => {});
  // The 15 s join bound never fires on its own here; a test that needs it says so.
  injectPendingSpawnWait(() => new Promise<void>(() => {}));
});

afterEach(() => {
  cleanup.resetGroupSurvivorsForTests();
  cleanup.resetUntrustedSlotsForTests();
  cleanup.resetOneShotSweeperForTests();
  warn.mockRestore();
  error.mockRestore();
  injectSpawnPty(null);
  injectPendingSpawnWait(null);
  __resetSupervisorForTests();
  engines.get("pty")!.caps.isolation = savedIsolation;
  _setSettingsFileForTests();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

function callerEnv(): Record<string, string> {
  mkdirSync(join(dir, "home"), { recursive: true });
  mkdirSync(join(dir, "config"), { recursive: true });
  return { PATH: "/usr/bin:/bin", HOME: join(dir, "home"), CLAUDE_CONFIG_DIR: join(dir, "config") };
}

const run = (req: Record<string, unknown> = {}) =>
  withPrintRuntime({ env: callerEnv() }, () => runOnceOnPty({ ...request, ...req }));

/** The PTY a slow spawn finally produces; `dispose` is its confirmation. `startMs: null` = identity unknown. */
function latePty(
  opts: PtyProcessOptions,
  dispose: () => Promise<void>,
  startMs: number | null = LATE_START_MS,
): never {
  return {
    label: "late",
    pid: LATE_PID,
    ...(startMs === null ? {} : { leaderStartMs: startMs }),
    sessionId: SID,
    cwd: opts.cwd,
    isAlive: () => true,
    lastTurnEndedAt: () => 0,
    exitInfo: () => null,
    runTurn: async () => {
      throw new Error("the late claude runs no turn");
    },
    dispose,
    confirmExit: dispose,
  } as never;
}

const unconfirmed = async (): Promise<void> => {
  throw new PtyExitUnconfirmedError("late", LATE_PID);
};

/** A spawn that takes `ms`, longer than the call's deadline, then lands `make(opts)`. Returns the root once known. */
function slowSpawn(ms: number, make: (opts: PtyProcessOptions) => never): () => string {
  let root = "";
  injectSpawnPty(async (opts) => {
    root = opts.env.CLAUDE_CONFIG_DIR!;
    roots.push(root);
    await sleep(ms);
    return make(opts);
  });
  return () => root;
}

/** Whether another call could take a slot: how many more the cap of two still allows. */
function freeSlots(): number {
  const taken: Array<ReturnType<typeof cleanup.acquireUntrustedOneShotSlot>> = [];
  for (;;) {
    const slot = cleanup.acquireUntrustedOneShotSlot();
    if (!slot) break;
    taken.push(slot);
  }
  const n = taken.length;
  for (const slot of taken) slot?.free();
  return n;
}

describe("a late PTY whose disposal fails keeps the root and the slot", () => {
  it("spawn timeout, then a late PTY, then a failed disposal: root and slot held, session quarantined", async () => {
    // Went red with the first pass removing the root before the late claude had landed, with the
    // survivor guard in `cleanupUntrustedOneShot` skipped, and with the slot handed over as clear.
    const rootOf = slowSpawn(300, (opts) => latePty(opts, unconfirmed));
    const result = await run({ timeoutMs: 100 });
    expect([1, 124]).toContain(result.exitCode);
    await until(() => rootOf() !== "");
    const root = rootOf();
    // The call is back, the claude has not landed: nothing removed, and the slot still counted.
    expect(existsSync(root)).toBe(true);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(1);

    await until(() => cleanup.groupSurvivorOf(root) !== undefined);
    await sleep(80); // the late retirement settles, the slot is handed over
    expect(cleanup.groupSurvivorOf(root)).toBe(LATE_PID);
    expect(existsSync(root)).toBe(true);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(1);
    expect(freeSlots()).toBe(1); // cap 2: one is still the survivor's
    expect(
      quarantineSnapshot().some(
        (q) => q.sessionKey.startsWith("oneshot:") && q.reason === "late-pty-exit-unconfirmed",
      ),
    ).toBe(true);
  });

  it("an unknown identity is held: no start time recorded, nothing signalled, root and slot kept", async () => {
    // Went red with a hold released when the leader's identity could not be compared.
    const rootOf = slowSpawn(200, (opts) => latePty(opts, unconfirmed, null));
    await run({ timeoutMs: 80 });
    await until(() => rootOf() !== "" && cleanup.groupSurvivorOf(rootOf()) !== undefined);
    await sleep(80);
    const root = rootOf();
    expect(cleanup.groupSurvivorOf(root)).toBe(LATE_PID);
    // A retry with a termination that cannot prove the group gone leaves it held.
    const terminate = async (): Promise<boolean> => false;
    expect(await cleanup.retrySurvivingGroups({ terminate, reap: async () => [] })).toBe(0);
    expect(existsSync(root)).toBe(true);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(1);
    expect(warned.join("\n")).toContain("start time not recorded");
  });
});

describe("a late confirmation that succeeds releases once", () => {
  it("removes the root and frees the slot exactly once when the late exit is confirmed", async () => {
    // Went red with the root removed on the first pass, and with the slot freed twice (3 slots granted).
    const rootOf = slowSpawn(250, (opts) => latePty(opts, () => sleep(250)));
    await run({ timeoutMs: 100 });
    await until(() => rootOf() !== "");
    const root = rootOf();
    await sleep(350); // landed (250 ms), confirmation (250 ms) still running
    expect(existsSync(root)).toBe(true);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(1);

    await until(() => !existsSync(root) && cleanup.untrustedOneShotsInFlight() === 0);
    expect(existsSync(root)).toBe(false);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(0);
    expect(cleanup.groupSurvivorCount()).toBe(0);
    expect(freeSlots()).toBe(2); // exactly the cap: not more, not fewer
  });

  it("a survivor later confirmed gone by the sweeper's retry frees its slot once", async () => {
    const rootOf = slowSpawn(150, (opts) => latePty(opts, unconfirmed));
    await run({ timeoutMs: 80 });
    await until(() => rootOf() !== "" && cleanup.groupSurvivorOf(rootOf()) !== undefined);
    await sleep(80);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(1);
    const cleared = await cleanup.retrySurvivingGroups({
      terminate: async () => true,
      reap: async () => [],
    });
    expect(cleared).toBe(1);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(0);
    expect(freeSlots()).toBe(2);
  });
});

describe("the 60 s late-slot ceiling only logs", () => {
  async function withCeiling(ms: number, body: () => Promise<void>): Promise<void> {
    const saved = cleanup.lateSlotCeilingMsForTests();
    cleanup.setLateSlotCeilingMsForTests(ms);
    try {
      await body();
    } finally {
      cleanup.setLateSlotCeilingMsForTests(saved);
    }
  }

  it("logs once past the ceiling and the root and slot are still held, also after a failed disposal", async () => {
    // Went red with the ceiling's timer freeing the slot, and with it removing the root.
    await withCeiling(60, async () => {
      const rootOf = slowSpawn(400, (opts) => latePty(opts, unconfirmed));
      await run({ timeoutMs: 100 });
      await sleep(200); // past the ceiling, before the late claude lands
      const root = rootOf();
      expect(warned.filter((line) => line.includes(CEILING_LINE))).toHaveLength(1);
      expect(existsSync(root)).toBe(true);
      expect(cleanup.untrustedOneShotsInFlight()).toBe(1);
      expect(freeSlots()).toBe(1);

      await until(() => cleanup.groupSurvivorOf(root) !== undefined);
      await sleep(80);
      expect(existsSync(root)).toBe(true);
      expect(cleanup.untrustedOneShotsInFlight()).toBe(1);
      expect(warned.filter((line) => line.includes(CEILING_LINE))).toHaveLength(1);
    });
  });
});

describe("an abort during a late retirement", () => {
  it("frees nothing early: the root and the slot are released once, when the late exit is confirmed", async () => {
    const controller = new AbortController();
    const rootOf = slowSpawn(250, (opts) => latePty(opts, () => sleep(200)));
    await run({ timeoutMs: 100, signal: controller.signal });
    await until(() => rootOf() !== "");
    const root = rootOf();
    controller.abort(); // the call is back; its retirement is still going
    await sleep(100);
    expect(existsSync(root)).toBe(true);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(1);

    await until(() => !existsSync(root) && cleanup.untrustedOneShotsInFlight() === 0);
    expect(existsSync(root)).toBe(false);
    expect(freeSlots()).toBe(2);
  });

  it("an abort that reaches the retirement while the spawn is pending still hands back the late retirement", async () => {
    // The abort retires the entry (not awaited: the spawn is in flight) before the call's own
    // deadline returns it. The call must hand back the late retirement, not return as if the
    // child were gone.
    const controller = new AbortController();
    const rootOf = slowSpawn(400, (opts) => latePty(opts, unconfirmed));
    const pending = run({ timeoutMs: 150, signal: controller.signal });
    await until(() => rootOf() !== "");
    controller.abort();
    await pending;
    const root = rootOf();
    expect(existsSync(root)).toBe(true);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(1);
    await until(() => cleanup.groupSurvivorOf(root) !== undefined);
    await sleep(80);
    expect(existsSync(root)).toBe(true);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(1);
  });
});

describe("the pending-spawn stand-in (pid 0) holds the root and the slot", () => {
  /** A call whose spawn is held until `release()`, retired from outside (as `/kill` does) once the bound has passed. */
  async function standIn(make: (opts: PtyProcessOptions) => never): Promise<{
    root: string;
    release: () => void;
    call: Promise<unknown>;
  }> {
    injectPendingSpawnWait(async () => {}); // the 15 s bound has passed
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let root = "";
    injectSpawnPty(async (opts) => {
      root = opts.env.CLAUDE_CONFIG_DIR!;
      roots.push(root);
      await held;
      return make(opts);
    });
    const call = run({ timeoutMs: 8000 }).then(
      (r) => r,
      (e) => e,
    );
    await until(() => root !== "");
    await killAllPtys(); // `/kill`: the stand-in is quarantined, the call is still waiting on its spawn
    return { root, release, call };
  }

  it("keeps the root against cleanup and the sweep, and the slot, while the spawn is unsettled", async () => {
    // Went red with the hold at the stand-in removed (the root was swept and the slot freed).
    const { root, release, call } = await standIn((opts) => latePty(opts, async () => {}));
    expect(cleanup.pendingSpawnHoldCount()).toBe(1);
    expect(cleanup.pendingSpawnHoldActive(root)).toBe(true);
    expect(quarantineSnapshot().some((q) => q.reason === "pending-spawn-unsettled")).toBe(true);
    // Nothing the sweeper would do removes it, however old.
    cleanup.sweepStaleOneShotDirs(tmpdir(), Date.now() + 3_600_000);
    expect(existsSync(root)).toBe(true);
    expect(freeSlots()).toBeLessThan(2);

    release(); // the spawn settles: landPty disposes what it produced, confirmed
    await call;
    await until(() => !existsSync(root) && cleanup.untrustedOneShotsInFlight() === 0);
    expect(cleanup.pendingSpawnHoldCount()).toBe(0);
    expect(existsSync(root)).toBe(false);
    expect(freeSlots()).toBe(2); // each reservation freed exactly once
  });

  it("hands the hold to the survivor when what the spawn produced cannot be confirmed gone", async () => {
    const { root, release, call } = await standIn((opts) => latePty(opts, unconfirmed));
    expect(cleanup.pendingSpawnHoldActive(root)).toBe(true);
    release();
    await call; // fail closed: the call reports the kept root
    await until(() => cleanup.groupSurvivorOf(root) !== undefined);
    await sleep(80);
    expect(cleanup.pendingSpawnHoldCount()).toBe(0);
    expect(cleanup.groupSurvivorOf(root)).toBe(LATE_PID);
    expect(existsSync(root)).toBe(true);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(1);
  });
});

describe("the pending-spawn hold itself", () => {
  it("shares the slot a settling call already holds, and releases it once when the spawn settles", async () => {
    let pending = true;
    const slot = cleanup.acquireUntrustedOneShotSlot()!;
    let retired!: () => void;
    slot.settle(
      "/root/a",
      new Promise<void>((resolve) => {
        retired = resolve;
      }),
    );
    cleanup.markPendingSpawnHold("/root/a", () => pending);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(1); // not a second reservation for the same call
    retired();
    await sleep(10);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(1); // handed to the hold
    pending = false;
    expect(cleanup.pendingSpawnHoldActive("/root/a")).toBe(false);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(0);
    expect(cleanup.pendingSpawnHoldActive("/root/a")).toBe(false); // again: still once
    expect(freeSlots()).toBe(2);
  });

  it("a spawn that has already settled is not held", () => {
    cleanup.markPendingSpawnHold("/root/b", () => false);
    expect(cleanup.pendingSpawnHoldCount()).toBe(0);
    expect(cleanup.untrustedOneShotsInFlight()).toBe(0);
  });
});
