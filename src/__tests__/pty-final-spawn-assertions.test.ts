/**
 * The final synchronous spawn assertion at every native Claude spawn (#581 cp6).
 *
 * `assertSessionWritable` is async and ignores fences. A session fenced after it passed (a
 * retirement that began, a process landing late) must still stop the spawn, so each site asks
 * `assertSessionSpawnable` on the line before the native call, after every await. This file
 * covers the runner's native PTY (trusted and untrusted one-shot) and the supervisor's respawn
 * and key-only first spawn. The other sites have their late-fence tests beside them:
 * `pty-spawn-fence.test.ts` (legacy runner, print engine, supervisor first spawn by session id),
 * `bus/__tests__/session-manager-quarantine.test.ts` (bus PTY, child, tmux) and
 * `bus/__tests__/schema-probe-spawn-fence.test.ts` (probe).
 *
 * Fake PTYs and a fake native spawn only. The native call is observed through `_ptySpawn`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { initConfig, loadSettings, reloadSettings } from "../config";
import {
  PtyClosedError,
  type PtyProcess,
  type PtyProcessOptions,
  spawnPty,
} from "../runner/pty-process";
import {
  __resetQuarantineForTests,
  fenceKey,
  PtyQuarantinedError,
  quarantineSession,
} from "../runner/pty-quarantine";
import {
  __resetSupervisorForTests,
  injectIsSessionResumable,
  injectMaxRetriesForTests,
  injectNewSessionId,
  injectRespawnRetriesForTests,
  injectSleep,
  injectSpawnPty,
  runOnPty,
  shutdownSupervisor,
} from "../runner/pty-supervisor";

const memStore = (initial?: string) => {
  let id: string | undefined = initial;
  return {
    load: async () => id,
    save: async (s: string) => {
      id = s;
    },
  };
};

const scope = () => ({
  sessionStore: memStore(),
  cwd: "/tmp/fake-cwd",
  mcpConfig: { path: undefined },
});

beforeEach(() => {
  __resetQuarantineForTests();
});

afterEach(() => {
  __resetQuarantineForTests();
});

// ─── the runner's native PTY ────────────────────────────────────────────────

/** A native spawn that records the call and fails, so a spawn that goes ahead is visible. */
function nativeSpy(): { calls: number; spawn: NonNullable<PtyProcessOptions["_ptySpawn"]> } {
  const spy = {
    calls: 0,
    spawn: (() => {
      spy.calls++;
      throw new Error("native spawn ran");
    }) as NonNullable<PtyProcessOptions["_ptySpawn"]>,
  };
  return spy;
}

function nativeOpts(over: Partial<PtyProcessOptions>): PtyProcessOptions {
  return {
    sessionId: "",
    cwd: "/tmp/fake-cwd",
    env: { PATH: "/usr/bin:/bin" },
    security: { level: "moderate", allowedTools: [], disallowedTools: [] },
    _skipReadySettle: true,
    ...over,
  };
}

describe("spawnPty: the assertion directly before the native call", () => {
  it("positive control: an unfenced spawn reaches the native call (trusted and untrusted)", async () => {
    // Without this, "no native call" below could just mean the harness never gets there.
    const trusted = nativeSpy();
    await expect(
      spawnPty(
        nativeOpts({ sessionKey: "thread:a", sessionId: "sess-1", _ptySpawn: trusted.spawn }),
      ),
    ).rejects.toThrow("native spawn ran");
    expect(trusted.calls).toBe(1);

    const untrusted = nativeSpy();
    await expect(
      spawnPty(
        nativeOpts({
          isolation: "untrusted",
          sessionKey: "oneshot:eph-1",
          _ptySpawn: untrusted.spawn,
        }),
      ),
    ).rejects.toThrow("native spawn ran");
    expect(untrusted.calls).toBe(1);
  });

  it("a trusted resume of a fenced session id does not spawn", async () => {
    // Fault (site: the assertion in `spawnPty`, removed): the fence is on the session id, which
    // the async gate never reads. Predicted result: `calls` is 1 and the rejection is the
    // spawn's own error instead of PtyQuarantinedError.
    const spy = nativeSpy();
    fenceKey("thread:other", {}, () => "sess-1");

    await expect(
      spawnPty(nativeOpts({ sessionKey: "thread:a", sessionId: "sess-1", _ptySpawn: spy.spawn })),
    ).rejects.toBeInstanceOf(PtyQuarantinedError);
    expect(spy.calls).toBe(0);
  });

  it("a trusted spawn on a fenced KEY does not spawn, whatever session it names", async () => {
    // Fault (site: `sessionKey` dropped from the assertion's target): the key is the only thing
    // that names the fence. Predicted result: `calls` is 1.
    const spy = nativeSpy();
    fenceKey("thread:a", {});

    await expect(
      spawnPty(nativeOpts({ sessionKey: "thread:a", newSessionId: "new-1", _ptySpawn: spy.spawn })),
    ).rejects.toBeInstanceOf(PtyQuarantinedError);
    expect(spy.calls).toBe(0);
  });

  it("a pre-allocated new session id is checked too", async () => {
    // Fault (site: `newSessionId` left out of the target): a retirement that holds the id the
    // spawn is about to claim is not seen. Predicted result: `calls` is 1.
    const spy = nativeSpy();
    fenceKey("thread:other", {}, () => "new-1");

    await expect(
      spawnPty(nativeOpts({ sessionKey: "thread:a", newSessionId: "new-1", _ptySpawn: spy.spawn })),
    ).rejects.toBeInstanceOf(PtyQuarantinedError);
    expect(spy.calls).toBe(0);
  });

  it("an untrusted one-shot names no session id: its ephemeral KEY is fenced, and it does not spawn", async () => {
    // Fault (site: the assertion made conditional on a non-empty `sessionId`, as it was before
    // #581 cp6): an untrusted spawn has no id, so nothing is asked. Predicted result: `calls` is 1.
    const spy = nativeSpy();
    fenceKey("oneshot:eph-1", {});

    await expect(
      spawnPty(
        nativeOpts({ isolation: "untrusted", sessionKey: "oneshot:eph-1", _ptySpawn: spy.spawn }),
      ),
    ).rejects.toBeInstanceOf(PtyQuarantinedError);
    expect(spy.calls).toBe(0);
  });

  it("a quarantine record stops a native spawn the same way a fence does", async () => {
    // Fault (site: the assertion, removed): the record is on the key. Predicted result: `calls` is 1.
    const spy = nativeSpy();
    quarantineSession(
      "thread:a",
      { label: "q", pid: 7, sessionId: "", confirmExit: async () => {} } as unknown as PtyProcess,
      "test",
    );

    await expect(
      spawnPty(nativeOpts({ sessionKey: "thread:a", sessionId: "sess-1", _ptySpawn: spy.spawn })),
    ).rejects.toBeInstanceOf(PtyQuarantinedError);
    expect(spy.calls).toBe(0);
  });

  it("a fence that lands while the argv is being prepared still stops the spawn (trusted)", async () => {
    // Fault (site: the assertion moved to the top of `spawnPty`, before `cols`/argv are read):
    // the fence lands after it. Predicted result: `calls` is 1.
    const spy = nativeSpy();
    const opts = nativeOpts({ sessionKey: "thread:a", sessionId: "sess-1", _ptySpawn: spy.spawn });
    Object.defineProperty(opts, "cols", {
      get: () => {
        fenceKey("thread:a", {});
        return 120;
      },
    });

    await expect(spawnPty(opts)).rejects.toBeInstanceOf(PtyQuarantinedError);
    expect(spy.calls).toBe(0);
  });

  it("a fence that lands while the argv is being prepared still stops the spawn (untrusted)", async () => {
    // Same fault as above, on the unconditional untrusted path. Predicted result: `calls` is 1.
    const spy = nativeSpy();
    const opts = nativeOpts({
      isolation: "untrusted",
      sessionKey: "oneshot:eph-1",
      _ptySpawn: spy.spawn,
    });
    Object.defineProperty(opts, "cols", {
      get: () => {
        fenceKey("oneshot:eph-1", {});
        return 120;
      },
    });

    await expect(spawnPty(opts)).rejects.toBeInstanceOf(PtyQuarantinedError);
    expect(spy.calls).toBe(0);
  });

  it("an untrusted fence that lands while the exact environment policy is applied is seen, and the environment is restored", async () => {
    // Fault (site: the assertion moved out of the `withCleanProcessEnv` callback, above it):
    // the policy is read while the daemon's environment is being masked, after that check.
    // Predicted result: `calls` is 1. The restore half guards the `finally` the throw now
    // crosses: the daemon's own PATH must be back.
    const spy = nativeSpy();
    let fenced = false;
    const env = new Proxy({ PATH: "/usr/bin:/bin" } as Record<string, string>, {
      getOwnPropertyDescriptor(target, key) {
        if (!fenced) {
          fenced = true;
          fenceKey("oneshot:eph-1", {});
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const before = process.env.PATH;

    await expect(
      spawnPty(
        nativeOpts({
          isolation: "untrusted",
          sessionKey: "oneshot:eph-1",
          env,
          _ptySpawn: spy.spawn,
        }),
      ),
    ).rejects.toBeInstanceOf(PtyQuarantinedError);

    expect(fenced).toBe(true);
    expect(spy.calls).toBe(0);
    expect(process.env.PATH).toBe(before);
  });
});

// ─── the supervisor's spawn sites ───────────────────────────────────────────

interface FakePty extends PtyProcess {
  disposeCalls: number;
}

function fakePty(over: { onDispose?: () => void; failTurn?: boolean }): FakePty {
  let alive = true;
  const fake = {
    label: "fake:4242",
    pid: 4242,
    sessionId: "sess-1",
    cwd: "/tmp/fake-cwd",
    disposeCalls: 0,
    isAlive: () => alive,
    lastTurnEndedAt: () => Date.now(),
    exitInfo: () => null,
    async runTurn(prompt: string) {
      if (over.failTurn) {
        alive = false;
        throw new PtyClosedError("fake:4242", 1, "SIGPIPE");
      }
      return { text: `echo:${prompt}`, bytesCaptured: 1, cleanBoundary: true, sessionId: "sess-1" };
    },
    async dispose() {
      fake.disposeCalls++;
      alive = false;
      over.onDispose?.();
    },
    async confirmExit() {},
  };
  return fake as unknown as FakePty;
}

describe("the supervisor's spawns", () => {
  beforeEach(async () => {
    __resetSupervisorForTests();
    await initConfig();
    await loadSettings();
    await reloadSettings();
    injectIsSessionResumable(async () => true);
    injectSleep(async () => {});
    injectMaxRetriesForTests(2);
    injectRespawnRetriesForTests(2);
  });

  afterEach(async () => {
    await shutdownSupervisor();
    __resetSupervisorForTests();
  });

  it("the respawn does not spawn on a key fenced after its gate passed", async () => {
    // The first process dies mid-turn. Its disposal parks a stand-in quarantine record on the
    // key; the respawn's gate confirms it (that is the last await) and, as it does, a fence
    // lands on the key, which the gate never reads. Fault (site: `assertSessionSpawnable` in
    // `respawnEntry`, removed): Predicted result: `spawnCount` is 2 and the call succeeds.
    let spawnCount = 0;
    const owner = {};
    const first = fakePty({
      failTurn: true,
      onDispose: () =>
        quarantineSession(
          "global",
          {
            label: "stand-in",
            pid: 99,
            sessionId: "",
            confirmExit: async () => {
              fenceKey("global", owner);
            },
          } as unknown as PtyProcess,
          "test",
        ),
    });
    injectSpawnPty(async (_o: PtyProcessOptions) => {
      spawnCount++;
      return spawnCount === 1 ? first : fakePty({});
    });

    const result = await runOnPty("global", "hello", { timeoutMs: 5000, ...scope() }).catch(
      (err: unknown) => err,
    );

    expect(spawnCount).toBe(1);
    expect(first.disposeCalls).toBeGreaterThan(0);
    const text = result instanceof Error ? result.message : JSON.stringify(result);
    expect(text).not.toContain('"exitCode":0');
  });

  it("a first spawn on a fresh session does not go ahead when the id it pre-allocates is fenced", async () => {
    // A fresh session has no stored id, so the spawn names the new one it mints. Fault (site:
    // `newSessionId` left out of `spawnEntry`'s effective id): the fence on that id is not seen.
    // Predicted result: `spawnCount` is 1.
    let spawnCount = 0;
    injectNewSessionId(() => "new-fixed");
    fenceKey("thread:other", {}, () => "new-fixed");
    injectSpawnPty(async () => {
      spawnCount++;
      return fakePty({});
    });

    const r = await runOnPty("thread:fresh", "hello", { timeoutMs: 5000, ...scope() }).catch(
      (err: unknown) => err,
    );

    injectNewSessionId(null);
    expect(r instanceof Error ? r.message : JSON.stringify(r)).toContain("quarantined");
    expect(spawnCount).toBe(0);
  });

  it("the final respawn attempt does not go ahead when the replacement id it mints is fenced", async () => {
    // The first process dies mid-turn, the first respawn attempt fails, and the final attempt
    // abandons the stored session and mints a new id (`dropResume`). Only that new id is
    // fenced: the stored one the first spawn resumed is free. Fault (site: `newSessionId`
    // left out of `respawnEntry`'s effective id, `opts.sessionId` alone): the minted id is
    // not asked about. Predicted result: `spawnCount` is 3 instead of 2.
    let spawnCount = 0;
    injectNewSessionId(() => "new-fixed");
    fenceKey("thread:other", {}, () => "new-fixed");
    injectMaxRetriesForTests(1);
    injectRespawnRetriesForTests(2);
    injectSpawnPty(async (_o: PtyProcessOptions) => {
      spawnCount++;
      if (spawnCount === 1) return fakePty({ failTurn: true });
      if (spawnCount === 2) throw new Error("respawn attempt fails");
      return fakePty({});
    });

    const r = await runOnPty("thread:fresh", "hello", {
      timeoutMs: 5000,
      ...scope(),
      sessionStore: memStore("sess-stored"),
    }).catch((err: unknown) => err);

    injectNewSessionId(null);
    expect(spawnCount).toBe(2);
    const text = r instanceof Error ? r.message : JSON.stringify(r);
    expect(text).not.toContain('"exitCode":0');
  });

  it("positive control: the same final respawn attempt spawns when the minted id is free", async () => {
    // Without this, `spawnCount` of 2 above could just mean the harness never reaches the
    // final attempt.
    let spawnCount = 0;
    injectNewSessionId(() => "new-fixed");
    injectMaxRetriesForTests(1);
    injectRespawnRetriesForTests(2);
    injectSpawnPty(async (_o: PtyProcessOptions) => {
      spawnCount++;
      if (spawnCount === 1) return fakePty({ failTurn: true });
      if (spawnCount === 2) throw new Error("respawn attempt fails");
      return fakePty({});
    });

    await runOnPty("thread:fresh", "hello", {
      timeoutMs: 5000,
      ...scope(),
      sessionStore: memStore("sess-stored"),
    }).catch((err: unknown) => err);

    injectNewSessionId(null);
    expect(spawnCount).toBe(3);
  });

  it("a first spawn does not go ahead on a fenced KEY, though the session it names is free", async () => {
    // Fault (site: `sessionKey` dropped from `spawnEntry`'s assertion): the key is the only
    // thing fenced, and the stored session id is not. Predicted result: `spawnCount` is 1.
    let spawnCount = 0;
    fenceKey("thread:k", {});
    injectSpawnPty(async () => {
      spawnCount++;
      return fakePty({});
    });

    const r = await runOnPty("thread:k", "hello", {
      timeoutMs: 5000,
      ...scope(),
      sessionStore: memStore("sess-free"),
    }).catch((err: unknown) => err);

    expect(r instanceof Error ? r.message : JSON.stringify(r)).toContain("quarantined");
    expect(spawnCount).toBe(0);
  });
});
