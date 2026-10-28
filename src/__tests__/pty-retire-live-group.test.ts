/**
 * #581 merged with #596: `retireLive` (`/clear`, restart, an unrecordable spawn) honours the PTY
 * group retirement's verdict. A PTY agent is retired through the common primitive; when that
 * quarantines the session, a leader the probe reports gone does not make the retirement a success.
 * Nothing here can signal a real pid: the OS is a stand-in throughout.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { PtyAgentProcess, type PtyHandle } from "../bus/session-agent-process";
import { SessionManager } from "../bus/session-manager";
import type { ProcessProbe } from "../bus/session-ownership";
import { __resetGroupUnconfirmedForTests } from "../runner/pty-group-confirm";
import { __resetQuarantineForTests, quarantineSnapshot } from "../runner/pty-quarantine";

type ExitCb = (info: { exitCode: number; signal?: number | string }) => void;

/** bun-pty 0.4.9: the FIRST kill() fires the exit event synchronously, whatever the signal. */
function fakeNative(pid = 424242) {
  const exits: ExitCb[] = [];
  let closing = false;
  let quitting = false;
  const fire = (): void => {
    for (const cb of [...exits]) cb({ exitCode: 0 });
  };
  return {
    pid,
    onExit: (cb: ExitCb) => {
      exits.push(cb);
      return { dispose() {} };
    },
    onData: () => ({ dispose() {} }),
    write(s: string) {
      if (s === "/quit") quitting = true;
      if (s === "\r" && quitting) fire(); // /quit: the native exit event fires
    },
    resize() {},
    kill() {
      if (closing) return;
      closing = true;
      fire();
    },
  };
}

let warn: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  __resetQuarantineForTests();
  __resetGroupUnconfirmedForTests();
  warn = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
  __resetQuarantineForTests();
});

test("/clear fails, and spawns nothing, when the group retirement quarantined the session", async () => {
  // The group never goes: every probe answers, so the PTY retirement cannot confirm and quarantines.
  const proc = new PtyAgentProcess("bus-review", fakeNative() as unknown as PtyHandle, {
    bootDialogMaxMs: 1,
    retire: {
      readPidIdentity: () => "id",
      signalPid: () => {},
      liveMembers: () => 1,
      exitCapMs: 150,
      exitGraceMs: 20,
    },
  });
  // ... while the bus probe reports the leader's pid gone: alone, that reads as retired.
  const probe: ProcessProbe = { read: async () => null, kill() {} };
  const manager = new SessionManager({
    commandOverride: "/bin/cat",
    argsOverride: [],
    sessionCollisionDetectMs: 0,
    processProbe: probe,
    persistRotatedSessionId: async () => {},
  });
  let spawns = 0;
  (manager as unknown as { spawnPty: () => Promise<PtyAgentProcess> }).spawnPty = async () => {
    spawns += 1;
    return proc;
  };
  await manager.spawnAgent(
    {
      id: "bus-review",
      cwd: "/tmp",
      session_id: "retire-live-group",
      supervision: "pty-stdin",
      permission_mode: "bypassPermissions",
    },
    "cli",
  );

  // Went red with the group-verdict check removed from `retireLive`'s confirm(): the clear took
  // the old claude as retired, rotated the session id and went on to spawn a replacement, which
  // only the agent's quarantine refused ("... is quarantined: its previous process is still
  // alive"), not the retirement.
  await expect(manager.clearSession("bus-review")).rejects.toThrow(/not confirmed gone/);
  expect(spawns).toBe(1);
  expect(quarantineSnapshot().map((q) => q.reason)).toContain("bus-clear-exit-unconfirmed");
}, 15_000);
