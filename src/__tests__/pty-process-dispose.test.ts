/**
 * `PtyProcess.dispose()` must return only once the process has really exited (#562 round 6,
 * R2g). Kill-and-resume depends on it: a writer that outlives `dispose()` can still append a
 * record that the next identical prompt would read as its own.
 *
 * It cannot be pinned with a real child: bun-pty reports an exit event as soon as
 * `kill("SIGTERM")` is called, whether or not the child obeyed (a `trap '' TERM` shell was
 * still alive 400ms later with its exit event already delivered). So `bun-pty` is replaced
 * here by a child that ignores SIGTERM and exits only after SIGKILL, and the kill timer is
 * driven by hand.
 *
 * Its own file because `mock.module` is process-wide for the file that installs it.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

interface FakeChild {
  pid: number;
  signals: string[];
  exitCbs: Array<(info: { exitCode: number; signal?: number | string }) => void>;
  onData: (cb: (d: string) => void) => { dispose(): void };
  onExit: (cb: (info: { exitCode: number; signal?: number | string }) => void) => {
    dispose(): void;
  };
  write: (d: string) => void;
  resize: () => void;
  kill: (sig?: string) => void;
}

let child: FakeChild | null = null;

mock.module("bun-pty", () => ({
  spawn: (): FakeChild => {
    const c: FakeChild = {
      pid: 424242,
      signals: [],
      exitCbs: [],
      onData: () => ({ dispose() {} }),
      onExit: (cb) => {
        c.exitCbs.push(cb);
        return { dispose() {} };
      },
      write() {},
      resize() {},
      kill(sig = "SIGTERM") {
        c.signals.push(sig);
        // SIGTERM is ignored; only SIGKILL ends the process.
        if (sig === "SIGKILL") {
          queueMicrotask(() => {
            for (const cb of c.exitCbs) cb({ exitCode: 0, signal: "SIGKILL" });
          });
        }
      },
    };
    child = c;
    return c;
  },
}));

const { spawnPty } = await import("../runner/pty-process");

afterEach(() => {
  child = null;
});

describe("PtyProcess.dispose — waits for the process to exit (R2g)", () => {
  test("a child that ignores SIGTERM keeps dispose pending until SIGKILL has taken it", async () => {
    // Fault (site: `dispose`, drop `await exited`): dispose returns right after SIGTERM is
    // sent. Predicted result with the fault: `settled` is already true before the kill timer
    // fires and the process is still alive.
    let killTimer: (() => void) | undefined;
    const proc = await spawnPty({
      sessionId: "",
      cwd: "/tmp",
      security: { level: "unrestricted", allowedTools: [], disallowedTools: [] },
      env: {},
      agentName: "test",
      _skipReadySettle: true,
      _skipClaudeArgs: true,
      transcriptPath: "/tmp/never-written.jsonl",
      _setTimeout: (cb, ms) => {
        if (ms === 2000) {
          killTimer = cb;
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return setTimeout(cb, ms);
      },
      _clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    });
    const fake = child as FakeChild | null;
    if (!fake) throw new Error("fake bun-pty was not used");

    let settled = false;
    const disposing = proc.dispose().then(() => {
      settled = true;
    });
    await new Promise<void>((r) => setTimeout(r, 30));

    expect(fake.signals).toEqual(["SIGTERM"]);
    expect(proc.isAlive()).toBe(true);
    expect(settled).toBe(false);
    expect(killTimer).toBeDefined();

    killTimer?.();
    await disposing;

    expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(proc.isAlive()).toBe(false);
  });
});
