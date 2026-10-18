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
      expect(result.retired).toEqual(["thread:fixture-thread"]);
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
});
