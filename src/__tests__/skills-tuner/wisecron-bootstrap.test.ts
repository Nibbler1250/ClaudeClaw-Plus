/**
 * Integration test for the wired wisecron outcome loop.
 *
 * Exercises the full path the new CLI `wisecron` group drives — propose →
 * persist → apply → baseline → mature → verdict — against the real bootstrap
 * wiring (registerWisecronSubjects → recorder-armed ApplyPipeline →
 * OutcomeRecorder), using a temp config + temp project root so it never touches
 * the live host. claude_md is the subject: its `broken_import_count` is a Tier 1b
 * artifact metric (always activatable), so the loop runs without any live
 * telemetry stream.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapWisecron,
  loadWisecronSettings,
} from "../../skills-tuner/cli/wisecron-bootstrap.js";
import { AuditLog } from "../../skills-tuner/core/audit-log.js";
import { computeProposalSignature, loadSecret } from "../../skills-tuner/core/security.js";
import type { TelemetryProvider } from "../../skills-tuner/core/telemetry.js";

/** Advertises nothing — artifact metrics still activate; stream metrics don't. */
class NullProvider implements TelemetryProvider {
  contractVersion() {
    return "1.0.0";
  }
  capabilities() {
    return [];
  }
  async query() {
    return [];
  }
}

let dir: string;
let configPath: string;
let projRoot: string;
let claudeMd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wisecron-boot-"));
  projRoot = join(dir, "proj");
  mkdirSync(projRoot, { recursive: true });
  claudeMd = join(projRoot, "CLAUDE.md");
  // A CLAUDE.md with one broken @-import → one observation → one proposal.
  writeFileSync(
    claudeMd,
    ["# Project", "", "@./does-not-exist.md", "", "Some content."].join("\n"),
    "utf8",
  );

  configPath = join(dir, "config.yaml");
  // Only claude_md enabled; db + project root in temp. The other 7 subjects are
  // disabled so registration never scans the live host.
  writeFileSync(
    configPath,
    [
      "wisecron:",
      "  enabled: true",
      "  scope: all",
      `  db_path: ${join(dir, "wisecron.db")}`,
      "  subjects:",
      "    claude_md:",
      "      enabled: true",
      "      config:",
      `        projectRoots: ["${projRoot}"]`,
      "    cron: { enabled: false }",
      "    hook: { enabled: false }",
      "    mcp_plugin: { enabled: false }",
      "    model_routing: { enabled: false }",
      "    prompt_template: { enabled: false }",
      "    memory: { enabled: false }",
      "    agent: { enabled: false }",
      "",
    ].join("\n"),
    "utf8",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("wisecron bootstrap — end-to-end outcome loop", () => {
  it("parses the wisecron block and registers only enabled subjects", () => {
    const settings = loadWisecronSettings(configPath);
    expect(settings.enabled).toBe(true);
    const bundle = bootstrapWisecron({
      configPath,
      telemetry: new NullProvider(),
      audit: new AuditLog(),
      runHealthChecks: false,
    });
    const names = bundle.registry
      .allSubjects()
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(["claude_md"]);
    bundle.db.close();
  });

  it("propose → persist → apply → baseline → mature → verdict", async () => {
    const audit = new AuditLog();
    const bundle = bootstrapWisecron({
      configPath,
      telemetry: new NullProvider(),
      audit,
      runHealthChecks: false,
    });
    const { db, engine, pipeline, recorder } = bundle;

    // 1. propose
    const cycle = await engine.runCycle("claude_md", new Date(0));
    expect(cycle.proposals.length).toBeGreaterThanOrEqual(1);

    // 2. persist (sign first, as the CLI cron-run does)
    const secret = loadSecret();
    for (const unsigned of cycle.proposals) {
      db.persistProposal({ ...unsigned, signature: computeProposalSignature(unsigned, secret) });
    }
    const pending = db.listProposals("pending");
    expect(pending.length).toBe(cycle.proposals.length);

    // 3. apply (first alternative) → baseline snapshot
    const target = pending[0]!;
    const altId = target.proposal.alternatives[0]!.id;
    const outcome = await pipeline.apply(target.proposal, altId, "cli");
    expect(outcome.revision.id).toBeGreaterThan(0);
    db.setProposalStatus(target.id, "applied");
    await recorder.snapshotBaseline(target.proposal); // durability flush (idempotent)

    expect(db.getStoredProposal(target.id)!.status).toBe("applied");

    // 4. baseline row exists for the artifact metric
    const baselineRows = db.getOutcomes(target.id);
    expect(baselineRows.length).toBe(1);
    expect(baselineRows[0]!.metric).toBe("broken_import_count");
    expect(baselineRows[0]!.baseline).not.toBeNull();
    expect(baselineRows[0]!.verdict).toBeNull(); // not matured yet

    // 5. mature past the 1-day window → a verdict is recorded
    const asOf = new Date(Date.now() + 3 * 86_400_000);
    const results = await recorder.runMaturation({
      asOf,
      revert: async () => false,
    });
    expect(results.length).toBe(1);
    expect(results[0]!.target_metric).toBe("broken_import_count");
    expect(["improved", "neutral", "regressed"]).toContain(results[0]!.verdict);

    const maturedRow = db.getOutcomes(target.id)[0]!;
    expect(maturedRow.verdict).not.toBeNull();
    expect(maturedRow.post).not.toBeNull();

    // audit chain stays tamper-evident across the whole loop
    expect(audit.verifyChain().ok).toBe(true);
    db.close();
  });

  it("persistProposal is idempotent — re-running cron-run does not resurrect applied", async () => {
    const bundle = bootstrapWisecron({
      configPath,
      telemetry: new NullProvider(),
      audit: new AuditLog(),
      runHealthChecks: false,
    });
    const { db, engine } = bundle;
    const secret = loadSecret();

    const cycle = await engine.runCycle("claude_md", new Date(0));
    const unsigned = cycle.proposals[0]!;
    const signed = { ...unsigned, signature: computeProposalSignature(unsigned, secret) };
    db.persistProposal(signed);
    db.setProposalStatus(String(signed.id), "applied");

    // Re-persist the same proposal id — ON CONFLICT DO NOTHING keeps it applied.
    db.persistProposal(signed);
    expect(db.getStoredProposal(String(signed.id))!.status).toBe("applied");
    expect(db.listProposals("pending").length).toBe(0);
    db.close();
  });
});
