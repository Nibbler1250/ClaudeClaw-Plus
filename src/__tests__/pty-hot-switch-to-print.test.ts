/**
 * #562 connector P1: `pty.enabled` flips true → false at runtime while a PTY still owns the
 * session key. The next runner turn resumes that session on print, so it must retire the live
 * PTY first (round 8/9 fence and quarantine apply), and must not spawn when the exit is
 * unconfirmed.
 *
 * The engines are observed through their seams: the supervisor's `injectSpawnPty` (fake PTY)
 * and the legacy `_setClaudeSpawnForTests`. Order is read off the legacy spawn itself: the
 * fake PTY must already be disposed when the `claude -p` spawn happens.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import * as configMod from "../config";
import { getSettings, initConfig, loadSettings } from "../config";
import * as runnerMod from "../runner";
import * as supervisorMod from "../runner/pty-supervisor";
import {
  __resetSupervisorForTests,
  injectEnsureAgentDir,
  injectIsSessionResumable,
  injectSleep,
  injectSpawnPty,
  resetSleep,
  runOnPty,
  snapshotSupervisor,
} from "../runner/pty-supervisor";
import { PtyQuarantinedError } from "../runner/pty-quarantine";
import type { PtyProcess, PtyProcessOptions } from "../runner/pty-process";
import { resetFallbackSession, resetSession } from "../sessions";

const STATE_DIR = join(process.cwd(), ".claude", "claudeclaw");
const AGENT = `hotswitch-agent-${process.pid}`;
const AGENT_DIR = join(process.cwd(), "agents", AGENT);

// The paths under test read and write the global session files; put back what we found.
let stateBefore: Map<string, string> | null = null;
async function snapshotDir(
  dir: string,
  into = new Map<string, string>(),
): Promise<Map<string, string>> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return into;
  }
  for (const name of names) {
    const p = join(dir, name);
    try {
      into.set(p, await readFile(p, "utf8"));
    } catch {
      await snapshotDir(p, into);
    }
  }
  return into;
}
async function restoreDir(dir: string, snap: Map<string, string>): Promise<void> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    const before = snap.get(p);
    if (before !== undefined) {
      await writeFile(p, before);
      continue;
    }
    if ([...snap.keys()].some((k) => k.startsWith(`${p}/`))) await restoreDir(p, snap);
    else await rm(p, { recursive: true, force: true });
  }
}
async function restoreDeleted(snap: Map<string, string>): Promise<void> {
  for (const [p, before] of snap) {
    if (await Bun.file(p).exists()) continue;
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, before);
  }
}

interface FakePty extends PtyProcess {
  disposed: boolean;
}
let ptys: FakePty[] = [];
/** Per legacy spawn: was every fake PTY already disposed at that moment? */
let legacySpawns: Array<{ args: string[]; ptysDisposed: boolean[] }> = [];

function makeFakePty(opts: PtyProcessOptions): FakePty {
  const sessionId = opts.sessionId || opts.newSessionId || "pty-fresh";
  const pty: FakePty = {
    label: `fake:${ptys.length}`,
    pid: 41_000 + ptys.length,
    sessionId,
    cwd: opts.cwd,
    disposed: false,
    isAlive: () => !pty.disposed,
    lastTurnEndedAt: () => 0,
    exitInfo: () => null,
    runTurn: async () => ({ text: "pty-ok", bytesCaptured: 6, cleanBoundary: true, sessionId }),
    dispose: async () => {
      pty.disposed = true;
    },
  };
  return pty;
}

const LEGACY_RESULT = JSON.stringify({
  type: "result",
  result: "legacy-ok",
  session_id: "legacy-session",
});

function stubSettings(ptyEnabled: boolean): void {
  const real = getSettings();
  spyOn(configMod, "getSettings").mockReturnValue({
    ...real,
    model: "primary-model",
    api: "",
    fallback: { model: "", api: "" },
    agentic: { ...real.agentic, enabled: false },
    session: { ...real.session, autoRotate: false },
    mcp: { ...real.mcp, shared: [] },
    pty: { ...real.pty, enabled: ptyEnabled, maxRetries: 0, backoffMs: [0] },
  } as ReturnType<typeof getSettings>);
}
function restoreSettings(): void {
  (configMod.getSettings as unknown as { mockRestore?: () => void }).mockRestore?.();
}

/** A live, idle PTY on `key`, as a pty-mode turn leaves behind. */
async function livePtyOn(key: string, agentName?: string): Promise<void> {
  await runOnPty(key, "warm", { timeoutMs: 1000, retry: false, agentName });
  expect(snapshotSupervisor().ptys.map((p) => p.sessionKey)).toContain(key);
}

beforeAll(async () => {
  await initConfig();
  await loadSettings();
  stateBefore = await snapshotDir(STATE_DIR);
  await mkdir(AGENT_DIR, { recursive: true });
  await writeFile(join(AGENT_DIR, "IDENTITY.md"), "test agent for the hot switch\n");
});

afterAll(async () => {
  if (stateBefore) {
    await restoreDir(STATE_DIR, stateBefore);
    await restoreDeleted(stateBefore);
  }
  await rm(AGENT_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  ptys = [];
  legacySpawns = [];
  __resetSupervisorForTests();
  injectSleep(async () => {});
  injectIsSessionResumable(async () => true);
  injectEnsureAgentDir(async () => AGENT_DIR);
  injectSpawnPty(async (opts) => {
    const pty = makeFakePty(opts);
    ptys.push(pty);
    return pty;
  });
  runnerMod._setClaudeSpawnForTests((args) => {
    legacySpawns.push({ args, ptysDisposed: ptys.map((p) => p.disposed) });
    return Bun.spawn(["printf", "%s\\n", LEGACY_RESULT], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  });
  await resetSession();
  await resetFallbackSession();
});

afterEach(() => {
  runnerMod._setClaudeSpawnForTests(null);
  // Spies are restored here, not at the end of each test: a failed assertion must not leak a
  // spy's recorded calls into the next test.
  mock.restore();
  __resetSupervisorForTests();
  resetSleep();
});

describe("#562 hot switch to print retires the live PTY first", () => {
  it("global: the PTY is disposed before the legacy spawn, and the turn runs on print", async () => {
    stubSettings(true);
    await livePtyOn("global");
    restoreSettings();
    stubSettings(false);
    const retire = spyOn(supervisorMod, "retirePtySession");

    const r = await runnerMod.run("hot-switch", "hello");

    expect(retire.mock.calls.map((c) => c[0])).toContain("global");
    expect(legacySpawns).toHaveLength(1);
    expect(legacySpawns[0].args).toContain("-p");
    // Order: at the moment of the legacy spawn the old PTY was already gone.
    expect(legacySpawns[0].ptysDisposed).toEqual([true]);
    expect(snapshotSupervisor().ptys).toHaveLength(0);
    expect(r.stdout).toBe("legacy-ok");
  });

  it("agent:<name>: the agent's PTY is retired before its legacy spawn", async () => {
    stubSettings(true);
    await livePtyOn(`agent:${AGENT}`, AGENT);
    restoreSettings();
    stubSettings(false);
    const retire = spyOn(supervisorMod, "retirePtySession");

    const r = await runnerMod.run("hot-switch", "hello", undefined, undefined, undefined, AGENT);

    expect(retire.mock.calls.map((c) => c[0])).toContain(`agent:${AGENT}`);
    expect(legacySpawns).toHaveLength(1);
    expect(legacySpawns[0].ptysDisposed).toEqual([true]);
    expect(snapshotSupervisor().ptys).toHaveLength(0);
    expect(r.stdout).toBe("legacy-ok");
  });

  it("dashboard chat (streamUserMessage) retires the global PTY before its legacy spawn", async () => {
    stubSettings(true);
    await livePtyOn("global");
    restoreSettings();
    stubSettings(false);

    const chunks: string[] = [];
    await runnerMod.streamUserMessage(
      "chat",
      "hello",
      (t) => chunks.push(t),
      () => {},
    );

    expect(legacySpawns).toHaveLength(1);
    expect(legacySpawns[0].ptysDisposed).toEqual([true]);
    expect(snapshotSupervisor().ptys).toHaveLength(0);
    expect(chunks).toEqual(["legacy-ok"]);
  });

  it("retirement not confirmed (quarantined): the turn fails and nothing is spawned on print", async () => {
    stubSettings(true);
    await livePtyOn("global");
    restoreSettings();
    stubSettings(false);
    const retire = spyOn(supervisorMod, "retirePtySession").mockRejectedValue(
      new PtyQuarantinedError("global"),
    );

    await expect(runnerMod.run("hot-switch", "hello")).rejects.toBeInstanceOf(PtyQuarantinedError);

    expect(retire).toHaveBeenCalledWith("global");
    expect(legacySpawns).toHaveLength(0);
  });

  it("no PTY entry: no retirement call, the print path is unchanged", async () => {
    stubSettings(false);
    const retire = spyOn(supervisorMod, "retirePtySession");

    const r = await runnerMod.run("hot-switch", "hello");

    expect(retire).not.toHaveBeenCalled();
    expect(legacySpawns).toHaveLength(1);
    expect(r.stdout).toBe("legacy-ok");
  });
});
