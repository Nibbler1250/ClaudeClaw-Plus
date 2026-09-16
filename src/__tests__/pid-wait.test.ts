/**
 * #315: `stop` / `--replace-existing` must not declare a daemon stopped (and
 * remove its PID file) while it is still draining. `waitForPidExit` is the
 * primitive they wait on.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfiguredDrainMs, stopGraceMs, waitForPidExit } from "../pid";

describe("waitForPidExit (#315)", () => {
  it("resolves true at once for a pid that does not exist", async () => {
    const t0 = Date.now();
    expect(await waitForPidExit(2 ** 22 - 7, 5000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it("resolves false at the deadline while the process is alive, true once it exits", async () => {
    const child = Bun.spawn(["sleep", "30"]);
    try {
      expect(await waitForPidExit(child.pid, 150, 20)).toBe(false);
      child.kill("SIGTERM");
      expect(await waitForPidExit(child.pid, 5000, 20)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("readConfiguredDrainMs reads a project's own settings.json, validated like the loader", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccplus-pid-drain-"));
    try {
      expect(await readConfiguredDrainMs(dir)).toBeUndefined(); // no file
      mkdirSync(join(dir, ".claude", "claudeclaw"), { recursive: true });
      const f = join(dir, ".claude", "claudeclaw", "settings.json");
      writeFileSync(f, JSON.stringify({ shutdown: { drainTurnsMs: 60_000 } }));
      expect(await readConfiguredDrainMs(dir)).toBe(60_000);
      expect(stopGraceMs(await readConfiguredDrainMs(dir))).toBe(65_000);
      writeFileSync(f, JSON.stringify({ shutdown: { drainTurnsMs: 0 } }));
      expect(await readConfiguredDrainMs(dir)).toBe(0);
      writeFileSync(f, JSON.stringify({ shutdown: { drainTurnsMs: -5 } }));
      expect(await readConfiguredDrainMs(dir)).toBeUndefined();
      writeFileSync(f, JSON.stringify({ shutdown: { drainTurnsMs: "soon" } }));
      expect(await readConfiguredDrainMs(dir)).toBeUndefined();
      writeFileSync(f, "{ not json");
      expect(await readConfiguredDrainMs(dir)).toBeUndefined();
      writeFileSync(f, JSON.stringify({}));
      expect(await readConfiguredDrainMs(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stopGraceMs = drain window + teardown margin, default 35s", () => {
    expect(stopGraceMs()).toBe(35_000);
    expect(stopGraceMs(0)).toBe(5_000);
    expect(stopGraceMs(10_000)).toBe(15_000);
  });
});
