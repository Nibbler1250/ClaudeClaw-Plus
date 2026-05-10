/**
 * Load tests for the skills-tuner MCP plugin.
 *
 * Verifies: concurrent reads, throughput, and large dataset handling.
 * Uses temp dirs; never touches production state.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ProposalsStore } from "../../src/skills-tuner/storage/proposals.js";
import { RefusedStore } from "../../src/skills-tuner/storage/refused.js";
import { Registry } from "../../src/skills-tuner/core/registry.js";
import { Engine } from "../../src/skills-tuner/core/engine.js";
import { BranchManager } from "../../src/skills-tuner/git_ops/branches.js";
import { makePendingTool } from "../../src/plugins/skills-tuner/tools/pending.js";
import {
  computeProposalSignature,
  loadSecret,
} from "../../src/skills-tuner/core/security.js";
import type { Proposal } from "../../src/skills-tuner/core/types.js";
import type { TunerConfig } from "../../src/skills-tuner/core/config.js";
import type { EngineBundle } from "../../src/skills-tuner/cli/bootstrap.js";

function makeTmpConfig(tmpDir: string): TunerConfig {
  return {
    models: {
      intent_classifier: "claude-haiku-4-5-20251001",
      detector: "claude-haiku-4-5-20251001",
      proposer_default: "claude-haiku-4-5-20251001",
      proposer_high_stakes: "claude-sonnet-4-6",
      judge: "claude-haiku-4-5-20251001",
    },
    detection: { confidence_floor: 0.6, max_proposals_per_run: 10, improvement_keywords_extra: [] },
    proposer: { alternatives_count: 2, language_preference: "en" },
    ui: { primary_adapter: "cli", follow_up_survey: false, follow_up_after_seconds: 3600 },
    storage: {
      proposals_jsonl: join(tmpDir, "proposals.jsonl"),
      refused_jsonl: join(tmpDir, "refused.jsonl"),
      schema_version: 1,
      backup_keep: 7,
      git_repo: tmpDir,
    },
    llm: { backend: "claude_cli", api_key: undefined },
    subjects: {},
  } as TunerConfig;
}

function makeProposalRecord(id: number): string {
  const secret = loadSecret();
  const base = {
    id,
    cluster_id: `cluster-${id}`,
    subject: "skills",
    kind: "patch",
    target_path: `/tmp/skill-${id}.md`,
    alternatives: [{ id: "A", label: "Fix", diff_or_content: `# Skill ${id}`, tradeoff: "" }],
    pattern_signature: `skills:/tmp/skill-${id}.md:patch`,
    created_at: new Date().toISOString(),
  };
  const signature = computeProposalSignature({ ...base, created_at: new Date(base.created_at) }, secret);
  const proposal = { ...base, signature };
  return JSON.stringify({ proposal, event: "created", ts: new Date().toISOString() });
}

function makeBundle(tmpDir: string): EngineBundle {
  const config = makeTmpConfig(tmpDir);
  const proposals = new ProposalsStore(config.storage.proposals_jsonl!);
  const refused = new RefusedStore(config.storage.refused_jsonl!);
  const registry = new Registry();
  const branches = new BranchManager(tmpDir);
  const engine = new Engine(config, registry, proposals, refused, branches);
  return { engine, proposals, refused, branches };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-load-"));
  process.env.TUNER_AUDIT_PATH = join(tmpDir, "audit.jsonl");
});

afterEach(() => {
  delete process.env.TUNER_AUDIT_PATH;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Load.1 — 100 parallel tuner_pending calls ────────────────────────────

describe("Load.1 — 100 parallel pending calls", () => {
  it("completes under 5s, no memory growth > 20MB", async () => {
    const proposalsPath = join(tmpDir, "proposals.jsonl");
    const lines = Array.from({ length: 50 }, (_, i) => makeProposalRecord(i + 1));
    writeFileSync(proposalsPath, lines.join("\n") + "\n");

    const bundle = makeBundle(tmpDir);
    const tool = makePendingTool(bundle);

    const heapBefore = process.memoryUsage().heapUsed;
    const start = Date.now();

    const results = await Promise.all(
      Array.from({ length: 100 }, () => Promise.resolve(tool.handler({}))),
    );

    const elapsed = Date.now() - start;
    const heapAfter = process.memoryUsage().heapUsed;
    const heapGrowthMB = (heapAfter - heapBefore) / 1024 / 1024;

    expect(results.length).toBe(100);
    expect(elapsed).toBeLessThan(5000);
    expect(heapGrowthMB).toBeLessThan(20);
  }, 8000);
});

// ── Load.2 — 1000 sequential tuner_pending calls ─────────────────────────

describe("Load.2 — 1000 sequential pending calls", () => {
  it("median latency < 50ms, p99 < 200ms", async () => {
    const proposalsPath = join(tmpDir, "proposals.jsonl");
    const lines = Array.from({ length: 10 }, (_, i) => makeProposalRecord(i + 1));
    writeFileSync(proposalsPath, lines.join("\n") + "\n");

    const bundle = makeBundle(tmpDir);
    const tool = makePendingTool(bundle);

    const latencies: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const t = Date.now();
      await Promise.resolve(tool.handler({}));
      latencies.push(Date.now() - t);
    }

    latencies.sort((a, b) => a - b);
    const median = latencies[Math.floor(latencies.length * 0.5)]!;
    const p99 = latencies[Math.floor(latencies.length * 0.99)]!;

    expect(median).toBeLessThan(50);
    expect(p99).toBeLessThan(200);
  }, 30000);
});

// ── Load.3 — large proposals.jsonl (10k records) ─────────────────────────

describe("Load.3 — 10k records in proposals.jsonl", () => {
  it("tuner_pending returns under 500ms", async () => {
    const proposalsPath = join(tmpDir, "proposals.jsonl");
    const lines = Array.from({ length: 10000 }, (_, i) => makeProposalRecord(i + 1));
    writeFileSync(proposalsPath, lines.join("\n") + "\n");

    const bundle = makeBundle(tmpDir);
    const tool = makePendingTool(bundle);

    const start = Date.now();
    const result = await Promise.resolve(tool.handler({})) as { pending: unknown[] };
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    // All 10k should be pending (no resolved ones)
    expect(result.pending.length).toBe(10000);
  }, 5000);
});
