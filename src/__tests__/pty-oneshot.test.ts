/**
 * #548: `runOnceOnPty`, the `pty` one-shot engine's turn. An untrusted call's
 * spawn carries the isolation flags and nothing else; a trusted call may
 * resume; either way the PTY is retired when the call returns.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests, reloadSettings } from "../config";
import { UNTRUSTED_CLAUDE_ARGS } from "../oneshot";
import {
  PtyClosedError,
  type PtyProcess,
  type PtyProcessOptions,
  type SpawnPty,
  __buildClaudeArgsForTests,
} from "../runner/pty-process";
import {
  __resetSupervisorForTests,
  injectIsSessionResumable,
  injectSpawnPty,
  runOnceOnPty,
  shutdownSupervisor,
  supervisorEntryCount,
} from "../runner/pty-supervisor";

let dir = "";
const spawned: PtyProcessOptions[] = [];
let disposed = 0;

const fakeSpawn: SpawnPty = async (opts) => {
  spawned.push(opts);
  return {
    label: "oneshot",
    pid: 4242,
    sessionId: opts.sessionId || opts.newSessionId || "",
    cwd: opts.cwd,
    isAlive: () => true,
    lastTurnEndedAt: () => 0,
    runTurn: async (prompt: string) => ({
      text: `echo:${prompt}`,
      bytesCaptured: prompt.length,
      cleanBoundary: true,
      sessionId: opts.sessionId || opts.newSessionId,
    }),
    dispose: async () => {
      disposed += 1;
    },
  } as unknown as PtyProcess;
};

beforeEach(async () => {
  __resetSupervisorForTests();
  spawned.length = 0;
  disposed = 0;
  dir = mkdtempSync(join(tmpdir(), "pty-oneshot-"));
  const file = join(dir, "settings.json");
  // The MCP multiplexer would be active for keyed PTYs with this config.
  writeFileSync(file, JSON.stringify({ mcp: { shared: ["srv"] }, web: { enabled: true } }));
  _setSettingsFileForTests(file);
  await reloadSettings();
  injectSpawnPty(fakeSpawn);
  injectIsSessionResumable(async () => true);
});

afterEach(async () => {
  await shutdownSupervisor();
  __resetSupervisorForTests();
  injectSpawnPty(null);
  injectIsSessionResumable(null);
  _setSettingsFileForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("runOnceOnPty", () => {
  it("untrusted: isolation flags only, fresh session, the given cwd, PTY retired", async () => {
    const res = await runOnceOnPty({
      prompt: "hi",
      timeoutMs: 5000,
      modelOverride: "m-1",
      cwd: dir,
      untrusted: true,
      resumeSessionId: "ignored",
    });
    expect(res.exitCode).toBe(0);
    expect(res.rawStdout).toContain("echo:");
    const opts = spawned[0] as PtyProcessOptions;
    expect(opts.untrusted).toBe(true);
    expect(opts.cwd).toBe(dir);
    expect(opts.sessionId).toBe("");
    expect(opts.mcpConfigPath).toBeUndefined();
    expect(opts.securityArgs).toBeUndefined();
    const args = __buildClaudeArgsForTests(opts);
    expect(args.slice(-UNTRUSTED_CLAUDE_ARGS.length)).toEqual([...UNTRUSTED_CLAUDE_ARGS]);
    for (const f of [
      "--resume",
      "--mcp-config",
      "--dangerously-skip-permissions",
      "--permission-mode",
    ]) {
      expect(args).not.toContain(f);
    }
    expect(args[args.indexOf("--model") + 1]).toBe("m-1");
    expect(disposed).toBe(1);
    expect(supervisorEntryCount()).toBe(0);
  });

  it("trusted: resumes the given session, keeps the operator's security args", async () => {
    await runOnceOnPty({
      prompt: "/compact",
      timeoutMs: 5000,
      untrusted: false,
      resumeSessionId: "sess-9",
    });
    const opts = spawned[0] as PtyProcessOptions;
    expect(opts.untrusted).toBeUndefined();
    expect(opts.sessionId).toBe("sess-9");
    const args = __buildClaudeArgsForTests(opts);
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-9");
    expect(args).not.toContain("--strict-mcp-config");
    expect(disposed).toBe(1);
  });

  /** Turns that never end on their own; disposing the PTY fails them, as a
   *  real PTY's close does. */
  function hangingTurns(): void {
    injectSpawnPty(async (opts) => {
      const p = (await fakeSpawn(opts)) as PtyProcess;
      let fail: (e: Error) => void = () => {};
      const dispose = p.dispose.bind(p);
      Object.assign(p, {
        runTurn: () => new Promise((_, reject) => (fail = reject)),
        dispose: async () => {
          fail(new PtyClosedError("oneshot", null, null));
          await dispose();
        },
      });
      return p;
    });
  }

  it("timeoutMs bounds the whole call: exit 124, PTY retired", async () => {
    hangingTurns();
    const started = Date.now();
    const res = await runOnceOnPty({ prompt: "x", timeoutMs: 100, untrusted: true });
    expect(res.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(supervisorEntryCount()).toBe(0);
  });

  it("an abort ends the call: exit 130", async () => {
    hangingTurns();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const res = await runOnceOnPty({
      prompt: "x",
      timeoutMs: 5000,
      untrusted: true,
      signal: ac.signal,
    });
    expect(res.exitCode).toBe(130);
  });
});
