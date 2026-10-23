/**
 * The schema probe starts its own claude (`--session-id <generated id>`) through bun-pty. It had
 * no final spawn gate (#581 cp6): a retirement that began (or a quarantine that landed) while the
 * factory awaited the trust pre-accept and the `bun-pty` import still let the probe fork. The
 * assertion now sits inside the environment callback, directly before the native call.
 *
 * The probe's claude is a stand-in that records that it was started. No real claude runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetQuarantineForTests,
  fenceKey,
  PtyQuarantinedError,
  quarantineSession,
} from "../../runner/pty-quarantine";
import type { PtyProcess } from "../../runner/pty-process";
import { defaultPtyRunnerFactory } from "../schema-probe-runner";

describe("defaultPtyRunnerFactory and the spawn gate", () => {
  let dir: string;
  let marker: string;
  let recorder: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccaw-probe-fence-"));
    marker = join(dir, "started.txt");
    recorder = join(dir, "recorder.sh");
    writeFileSync(recorder, `#!/bin/sh\necho started > "${marker}"\n`, { mode: 0o755 });
    chmodSync(recorder, 0o755);
    __resetQuarantineForTests();
  });
  afterEach(() => {
    __resetQuarantineForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  const spawnArgs = (sessionId: string) => ({
    cwd: dir,
    sessionId,
    claudeBin: recorder,
    // The home the trust pre-accept writes under: never the operator's real one.
    homeDir: dir,
  });

  it("positive control: an unfenced probe starts its claude", async () => {
    // Without this, the absent marker below could mean the stand-in never runs here at all.
    const runner = await defaultPtyRunnerFactory(spawnArgs("probe-free"));

    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(marker)).toBe(true);
    await runner.retire?.().catch(() => undefined);
  });

  it("does not start claude on a probe key fenced after the factory's awaits", async () => {
    // Fault (site: the assertion in `defaultPtyRunnerFactory`, removed): the factory awaits
    // the trust pre-accept and the `bun-pty` import and then forks. Predicted result: the
    // stand-in starts, `started.txt` exists and the factory resolves.
    fenceKey("schema-probe:probe-1", {});

    await expect(defaultPtyRunnerFactory(spawnArgs("probe-1"))).rejects.toBeInstanceOf(
      PtyQuarantinedError,
    );

    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(marker)).toBe(false);
  });

  it("does not start claude on a probe session id whose process is quarantined", async () => {
    // Fault (site: `sessionId` left out of the assertion's target): only the id names the
    // quarantined process. Predicted result: the stand-in starts.
    quarantineSession(
      "thread:other",
      {
        label: "q",
        pid: 7,
        sessionId: "probe-2",
        confirmExit: async () => {},
      } as unknown as PtyProcess,
      "test",
    );

    await expect(defaultPtyRunnerFactory(spawnArgs("probe-2"))).rejects.toBeInstanceOf(
      PtyQuarantinedError,
    );

    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(marker)).toBe(false);
  });
});
