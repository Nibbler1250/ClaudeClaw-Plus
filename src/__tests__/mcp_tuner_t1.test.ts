/**
 * T1 adversarial tests — basic attack vectors for the skills-tuner MCP plugin.
 *
 * Tests tool handlers directly (not via MCP subprocess) for speed.
 * Uses temp files; never touches production proposals.jsonl / audit.jsonl.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import { ProposalsStore } from "../../src/skills-tuner/storage/proposals.js";
import { RefusedStore } from "../../src/skills-tuner/storage/refused.js";
import { Registry } from "../../src/skills-tuner/core/registry.js";
import { Engine } from "../../src/skills-tuner/core/engine.js";
import { BranchManager } from "../../src/skills-tuner/git_ops/branches.js";
import { PluginMcpBridge, _resetMcpBridge } from "../../src/plugins/mcp-bridge.js";
import { makePendingTool } from "../../src/plugins/skills-tuner/tools/pending.js";
import { makeApplyTool } from "../../src/plugins/skills-tuner/tools/apply.js";
import { makeSkipTool } from "../../src/plugins/skills-tuner/tools/skip.js";
import { makeRevertTool } from "../../src/plugins/skills-tuner/tools/revert.js";
import {
  computeProposalSignature,
  verifyProposalSignature,
  loadSecret,
} from "../../src/skills-tuner/core/security.js";
import type { Proposal } from "../../src/skills-tuner/core/types.js";
import type { TunerConfig } from "../../src/skills-tuner/core/config.js";

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

function makeTestProposal(overrides: Partial<Proposal> = {}): Proposal {
  const secret = loadSecret();
  const base = {
    id: 1,
    cluster_id: "test-cluster",
    subject: "skills",
    kind: "patch",
    target_path: "/tmp/nonexistent.md",
    alternatives: [{ id: "A", label: "Fix", diff_or_content: "# Fixed", tradeoff: "" }],
    pattern_signature: "skills:/tmp/nonexistent.md:patch",
    created_at: new Date(),
    ...overrides,
  };
  const signature = computeProposalSignature(base, secret);
  return { ...base, signature };
}

function writePendingProposal(store: ProposalsStore, proposal: Proposal): void {
  store.append({ proposal, event: "created", ts: new Date().toISOString() });
}

let tmpDir: string;
let proposals: ProposalsStore;
let refused: RefusedStore;
let engine: Engine;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-t1-"));
  const config = makeTmpConfig(tmpDir);
  proposals = new ProposalsStore(config.storage.proposals_jsonl!);
  refused = new RefusedStore(config.storage.refused_jsonl!);
  const registry = new Registry();
  const branches = new BranchManager(tmpDir);
  engine = new Engine(config, registry, proposals, refused, branches);
  _resetMcpBridge();
  process.env.TUNER_AUDIT_PATH = join(tmpDir, "audit.jsonl");
});

afterEach(() => {
  delete process.env.TUNER_AUDIT_PATH;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  _resetMcpBridge();
});

const bundle = () => ({ engine, proposals, refused, branches: new BranchManager(tmpDir) });

// ── T1.1 — bridge rejects invocation of unknown FQN ──────────────────────────

describe("T1.1 — unknown tool FQN", () => {
  it("invokeTool throws for unknown FQN", async () => {
    const bridge = new PluginMcpBridge(join(tmpDir, "audit.jsonl"));
    await expect(bridge.invokeTool("nonexistent__tool", {})).rejects.toThrow(/Unknown tool/);
  });
});

// ── T1.2 — tuner_apply rejects invalid alternative_id ─────────────────────

describe("T1.2 — invalid alternative_id rejected by Zod", () => {
  it("schema rejects alternative_id='Z'", () => {
    const tool = makeApplyTool(bundle() as Parameters<typeof makeApplyTool>[0]);
    const result = tool.schema.safeParse({ id: 1, alternative_id: "Z" });
    expect(result.success).toBe(false);
  });
});

// ── T1.3 — tuner_pending rejects extra fields (strict) ────────────────────

describe("T1.3 — strict schema rejects extra fields", () => {
  it("tuner_pending rejects extra field", () => {
    const tool = makePendingTool(bundle() as Parameters<typeof makePendingTool>[0]);
    const result = tool.schema.safeParse({ unexpected: "field" });
    expect(result.success).toBe(false);
  });

  it("tuner_apply rejects extra field", () => {
    const tool = makeApplyTool(bundle() as Parameters<typeof makeApplyTool>[0]);
    const result = tool.schema.safeParse({ id: 1, alternative_id: "A", extra: true });
    expect(result.success).toBe(false);
  });
});

// ── T1.4 — tuner_cron_run rejects wrong type for 'since' ──────────────────

describe("T1.4 — type mismatch for since", () => {
  it("cron_run schema rejects number for since field", async () => {
    const { makeCronRunTool } = await import("../../src/plugins/skills-tuner/tools/cron-run.js");
    const tool = makeCronRunTool(bundle() as Parameters<typeof makeCronRunTool>[0]);
    const result = tool.schema.safeParse({ since: -1 });
    expect(result.success).toBe(false);
  });
});

// ── T1.5 — skip handler throws for non-existent proposal ──────────────────

describe("T1.5 — skip non-existent proposal", () => {
  it("throws for unknown proposal id", async () => {
    const tool = makeSkipTool(bundle() as Parameters<typeof makeSkipTool>[0]);
    await expect(tool.handler({ id: 9999, reason: "test" })).rejects.toThrow(/not found/i);
  });
});

// ── T1.6 — revert pending (not applied) proposal ──────────────────────────

describe("T1.6 — revert not-applied proposal", () => {
  it("throws 'No applied record found'", async () => {
    const proposal = makeTestProposal({ id: 42 });
    writePendingProposal(proposals, proposal);
    const tool = makeRevertTool(bundle() as Parameters<typeof makeRevertTool>[0]);
    await expect(tool.handler({ id: 42 })).rejects.toThrow(/No applied record/);
  });
});

// ── T1.7 — bridge wraps handler exceptions as structured errors ────────────

describe("T1.7 — bridge structured error on handler exception", () => {
  it("invokeTool propagates handler exception", async () => {
    const bridge = new PluginMcpBridge(join(tmpDir, "audit.jsonl"));
    bridge.registerPluginTool("test-plugin", {
      name: "boom",
      description: "always fails",
      schema: z.object({}).strict(),
      handler: async () => { throw new Error("deliberate test error"); },
    });
    await expect(bridge.invokeTool("test-plugin__boom", {})).rejects.toThrow("deliberate test error");
  });
});

// ── T1.8 — HMAC tamper detected ──────────────────────────────────────────

describe("T1.8 — HMAC tamper rejected", () => {
  it("verifyProposalSignature returns false for tampered proposal", () => {
    const secret = loadSecret();
    const proposal = makeTestProposal({ id: 1 });
    expect(verifyProposalSignature(proposal, secret)).toBe(true);

    const tampered: Proposal = { ...proposal, signature: "deadbeef".repeat(8) };
    expect(verifyProposalSignature(tampered, secret)).toBe(false);
  });

  it("verifyProposalSignature returns false for empty signature", () => {
    const secret = loadSecret();
    const proposal = makeTestProposal({ id: 2 });
    const tampered: Proposal = { ...proposal, signature: "" };
    expect(verifyProposalSignature(tampered, secret)).toBe(false);
  });
});
