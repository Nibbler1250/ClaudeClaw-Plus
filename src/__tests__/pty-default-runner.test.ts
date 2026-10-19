import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fixture(scenario: string) {
  const cwd = mkdtempSync(join(tmpdir(), "pty-default-"));
  try {
    const proc = Bun.spawn(
      [process.execPath, "run", join(import.meta.dir, "fixtures/pty-default-runner.ts"), scenario],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`fixture failed: ${out}\n${err}`);
    const line = out.split("\n").find((line) => line.startsWith("FIXTURE_RESULT "));
    if (!line) throw new Error(`fixture produced no result: ${out}\n${err}`);
    return JSON.parse(line.slice("FIXTURE_RESULT ".length));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("#550 default runner routing", () => {
  it("a due cron job reaches PTY with freshly generated defaults", async () => {
    const result = await fixture("cron");
    expect(result.enabled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.ptyCalls).toEqual(["thread:due"]);
    expect(result.agentPrintCalls).toBe(0);
  });
  it("explicit pty.enabled false keeps cron on print", async () => {
    const result = await fixture("legacy");
    expect(result.enabled).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.ptyCalls).toEqual([]);
    expect(result.agentPrintCalls).toBe(1);
  });
  it("bootstrap follows PTY rather than an unconditional print exception", async () => {
    const result = await fixture("bootstrap");
    expect(result.primaryRoute).toBe("pty");
    expect(result.agentPrintCalls).toBe(0);
  });
  for (const scenario of ["corrupt", "stale", "compact"]) {
    it(`${scenario} retry retires the old PTY and follows the configured engine`, async () => {
      const result = await fixture(scenario);
      expect(result.primaryRoute).toBe("pty");
      expect(result.exitCode).toBe(0);
      expect(result.ptyCalls).toEqual(["thread:fixture-thread"]);
      // compact: the up-front retire of the wedged PTY, the memory save's and the
      // /compact's own `skipLive` retire (#549), and the retry's. Each is idempotent.
      expect(result.retired).toEqual(
        scenario === "compact" ? Array(4).fill("thread:fixture-thread") : ["thread:fixture-thread"],
      );
      expect(result.agentPrintCalls).toBe(0);
    });
    it(`${scenario} retry preserves the explicit print opt-out`, async () => {
      const result = await fixture(`legacy-${scenario}`);
      expect(result.primaryRoute).toBe("legacy");
      expect(result.exitCode).toBe(0);
      expect(result.ptyCalls).toEqual([]);
      expect(result.retired).toEqual([]);
      expect(result.agentPrintCalls).toBe(1);
    });
  }
  it("retires the actual timed-out PTY before memory save or compact can resume it", async () => {
    const result = await fixture("compact");
    expect(result.events[0]).toBe("timeout");
    // The process is gone before EITHER utility --resume starts, and both resume the
    // old session through the oneshot module's print engine (the configured default).
    expect(result.events.indexOf("retire")).toBeLessThan(result.events.indexOf("utility-memory"));
    expect(result.events.indexOf("disposed")).toBeLessThan(result.events.indexOf("utility-memory"));
    expect(result.events.indexOf("disposed")).toBeLessThan(
      result.events.indexOf("utility-compact"),
    );
    expect(result.utilityResumes).toEqual([
      { prompt: "memory", resume: "old-sid" },
      { prompt: "/compact", resume: "old-sid" },
    ]);
    expect(result.oneShotLog).toEqual([
      { route: "memory.save.precompact", engine: "print", exitCode: 0 },
      { route: "compact", engine: "print", exitCode: 0 },
    ]);
    expect(result.exitCode).toBe(0);
  });
  it("a recovery call is one attempt: no supervisor retries compounded on top of the downstream recovery", async () => {
    // pty.maxRetries is 5 and the PTY times out on every turn. The stale/corrupt recovery
    // times out (exit 124), which starts the compact block and its post-compact recovery:
    // two recovery calls, each ONE turn. With the full retry envelope that was 6 + 6.
    const result = await fixture("recovery-timeout");
    expect(result.retryFlags).toEqual([false, false]);
    expect(result.events.filter((event: string) => event === "timeout")).toHaveLength(2);
  });
  for (const scenario of ["corrupt", "stale", "compact"]) {
    it(`${scenario}: the recovery call goes out with retry false`, async () => {
      expect((await fixture(scenario)).retryFlags).toEqual([false]);
    });
  }
  it("a fallback's stale-session recovery is one attempt; the fallback's own first attempt is not changed", async () => {
    expect((await fixture("fallback-model")).retryFlags).toEqual([null, false]);
  });
  it("the fallback's own corruption retry is one attempt; its first attempt keeps the normal envelope", async () => {
    // fallback-rendered: the primary hits the rate limit, the fallback attempt renders a
    // signature error, and the fallback is retried fresh. Only that retry is `retry: false`.
    expect((await fixture("fallback-rendered")).retryFlags).toEqual([null, false]);
  });
  it("recovers signature errors rendered by a PTY that returned exit zero", async () => {
    const result = await fixture("rendered-corrupt");
    expect(result.ptyCalls).toHaveLength(1);
    expect(result.retired).toHaveLength(1);
  });
  it("keeps the model override when retrying a fallback whose configured model is empty", async () => {
    const result = await fixture("fallback-model");
    expect(result.ptyCalls).toHaveLength(2);
    expect(result.modelOverrides[1]).toBe("override-model");
  });
  it("recovers a signature error rendered by the fallback PTY", async () => {
    const result = await fixture("fallback-rendered");
    expect(result.ptyCalls).toHaveLength(2);
    expect(result.retired).toEqual(["fallback:thread:fixture-thread"]);
  });
  it("streams chunk and tool events during a rate-limit fallback", async () => {
    const result = await fixture("fallback-stream");
    expect(result.ptyCalls).toHaveLength(1);
    expect(result.chunks).toEqual(["fallback-chunk"]);
    expect(result.tools).toEqual(["fallback-tool"]);
  });
  it("bootstrap reserves the queue, uses one bounded attempt, and releases a later chat", async () => {
    const result = await fixture("bootstrap-attempt");
    expect(result.bootstrapError).toContain("124");
    expect(result.events.filter((event: string) => event === "timeout")).toHaveLength(1);
    // Capped at BOOTSTRAP_PTY_MAX_MS (120 s), under the configured 5 min timeouts.default.
    expect(result.bootstrapTimeoutMs).toBe(120_000);
    expect(result.ptyCalls).toEqual(["global", "global"]);
    expect(result.exitCode).toBe(0);
  });
  it("dashboard emits a PTY fallback reply exactly once when it streams chunks", async () => {
    const result = await fixture("dashboard-fallback-chunks");
    expect(result.ptyCalls).toEqual(["global", "fallback:global"]);
    expect(result.chunks).toEqual([
      "You've hit your limit · resets 5pm (UTC)",
      "fallback-",
      "reply",
    ]);
    expect(result.chunks.join("").split("fallback-reply")).toHaveLength(2);
  });
  it("dashboard emits silent fallback stdout once after the primary streamed its notice", async () => {
    const result = await fixture("dashboard-fallback-silent");
    expect(result.ptyCalls).toEqual(["global", "fallback:global"]);
    expect(result.chunks.filter(Boolean)).toEqual([
      "You've hit your limit · resets 5pm (UTC)",
      "fallback-reply",
    ]);
  });
  it("non-streaming fallback still returns its buffered stdout", async () => {
    const result = await fixture("dashboard-fallback-buffered");
    expect(result.exitCode).toBe(0);
    expect(result.resultStdout).toBe("fallback-reply");
    expect(result.chunks).toEqual([]);
  });
});
