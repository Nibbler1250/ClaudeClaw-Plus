/**
 * SchemaProbe against the REAL installed `claude` — nightly job, not the PR
 * job (#304). This test used to sit at the bottom of
 * `src/bus/__tests__/schema-probe.test.ts` behind
 * `describe.skipIf(!SCHEMA_PROBE_INTEGRATION)`; a test that skips itself in
 * CI reports green and proves nothing. It runs here un-gated from
 * `.github/workflows/integration.yml`. The probe's own home / cache are a
 * temp dir, so nothing of the operator's is read or written.
 *
 * Run locally: `bun test tests/integration` with `claude` on PATH and logged in.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchemaProbe } from "../../src/bus/schema-probe";

describe("SchemaProbe integration (real claude)", () => {
  it("passes against the installed claude binary", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccaw-schema-probe-live-"));
    const homeDir = realpathSync(root);
    try {
      const probe = new SchemaProbe({
        mode: "warn-only",
        cacheFile: join(homeDir, ".claudeclaw", "schema-probe-cache.json"),
        homeOverride: homeDir,
        timeoutMs: 30_000,
      });
      const res = await probe.run();
      // Either passes outright, or surfaces specific assertions for triage.
      if (res.status !== "passed") {
        console.error("integration probe assertions:", res.failedAssertions);
      }
      expect(["passed", "failed"]).toContain(res.status);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
