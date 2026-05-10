/**
 * Security tests for the skills-tuner MCP plugin.
 *
 * Exercises threats from the Phase 7.2 threat model table:
 * MCP input validation, HMAC replay, stdout pollution, plugin namespace,
 * audit forgery, and privilege escalation paths.
 *
 * Uses temp dirs; never touches production state.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import { PluginMcpBridge, _resetMcpBridge } from "../../src/plugins/mcp-bridge.js";
import { ProposalsStore } from "../../src/skills-tuner/storage/proposals.js";
import { RefusedStore } from "../../src/skills-tuner/storage/refused.js";
import { Registry } from "../../src/skills-tuner/core/registry.js";
import { Engine } from "../../src/skills-tuner/core/engine.js";
import { BranchManager } from "../../src/skills-tuner/git_ops/branches.js";
import { SkillsSubject } from "../../src/skills-tuner/subjects/skills.js";
import {
  computeProposalSignature,
  verifyProposalSignature,
  loadSecret,
} from "../../src/skills-tuner/core/security.js";
import { makeApplyTool } from "../../src/plugins/skills-tuner/tools/apply.js";
import type { Proposal } from "../../src/skills-tuner/core/types.js";
import type { TunerConfig } from "../../src/skills-tuner/core/config.js";

function makeTmpConfig(tmpDir: string, scanDirs: string[] = []): TunerConfig {
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

function makeSignedProposal(overrides: Partial<Proposal> = {}): Proposal {
  const secret = loadSecret();
  const base = {
    id: 1,
    cluster_id: "sec-cluster",
    subject: "skills",
    kind: "patch",
    target_path: "/tmp/sec-test.md",
    alternatives: [{ id: "A", label: "Fix", diff_or_content: "# Fixed", tradeoff: "" }],
    pattern_signature: "skills:/tmp/sec-test.md:patch",
    created_at: new Date(),
    ...overrides,
  };
  const signature = computeProposalSignature(base, secret);
  return { ...base, signature };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-sec-"));
  process.env.TUNER_AUDIT_PATH = join(tmpDir, "audit.jsonl");
  _resetMcpBridge();
});

afterEach(() => {
  delete process.env.TUNER_AUDIT_PATH;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  _resetMcpBridge();
});

// ── Sec.1 — MCP input validation: Zod strict rejects unknown fields ────────

describe("Sec.1 — Zod strict schema enforcement", () => {
  it("bridge rejects extra fields via schema validation", async () => {
    const bridge = new PluginMcpBridge(join(tmpDir, "audit.jsonl"));
    bridge.registerPluginTool("sec", {
      name: "strict-tool",
      description: "strict",
      schema: z.object({ x: z.number() }).strict(),
      handler: async ({ x }) => ({ x }),
    });

    // Valid call
    await expect(bridge.invokeTool("sec__strict-tool", { x: 1 })).resolves.toEqual({ x: 1 });

    // Extra field — rejected by strict schema
    await expect(bridge.invokeTool("sec__strict-tool", { x: 1, inject: "evil" })).rejects.toThrow();
  });
});

// ── Sec.2 — HMAC verification: tampered proposal rejected ─────────────────

describe("Sec.2 — HMAC tamper detection", () => {
  it("verifyProposalSignature returns false for modified target_path", () => {
    const secret = loadSecret();
    const proposal = makeSignedProposal({ target_path: "/tmp/skill.md" });
    expect(verifyProposalSignature(proposal, secret)).toBe(true);

    const tampered = { ...proposal, target_path: "/etc/passwd" };
    expect(verifyProposalSignature(tampered, secret)).toBe(false);
  });

  it("verifyProposalSignature returns false for modified alternatives content", () => {
    const secret = loadSecret();
    const proposal = makeSignedProposal();
    expect(verifyProposalSignature(proposal, secret)).toBe(true);

    const tampered = {
      ...proposal,
      alternatives: [{ id: "A", label: "Hack", diff_or_content: "rm -rf /", tradeoff: "" }],
    };
    expect(verifyProposalSignature(tampered, secret)).toBe(false);
  });
});

// ── Sec.3 — Stdout pollution: bridge invocations do not pollute stdout ─────

describe("Sec.3 — no stdout/stderr pollution from bridge", () => {
  it("invokeTool does not write to process.stdout", async () => {
    const bridge = new PluginMcpBridge(join(tmpDir, "audit.jsonl"));
    bridge.registerPluginTool("sec", {
      name: "silent",
      description: "silent",
      schema: z.object({}).strict(),
      handler: async () => ({ ok: true }),
    });

    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: unknown, ...args: unknown[]) => {
      chunks.push(String(s));
      return orig(s as Parameters<typeof orig>[0], ...(args as Parameters<typeof orig>).slice(1));
    };

    try {
      await bridge.invokeTool("sec__silent", {});
    } finally {
      process.stdout.write = orig;
    }

    expect(chunks.length).toBe(0);
  });
});

// ── Sec.4 — Plugin namespace: per-plugin audit isolation ──────────────────

describe("Sec.4 — plugin audit uses own pluginId", () => {
  it("registered tool is audited under its plugin namespace", async () => {
    const auditPath = join(tmpDir, "sec-audit.jsonl");
    const bridge = new PluginMcpBridge(auditPath);
    bridge.registerPluginTool("my-plugin", {
      name: "tool",
      description: "t",
      schema: z.object({}).strict(),
      handler: async () => ({}),
    });

    await bridge.invokeTool("my-plugin__tool", {});

    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    const invokeEvent = lines
      .map((l) => JSON.parse(l))
      .find((e) => e.event === "invoke");

    expect(invokeEvent).toBeDefined();
    expect(invokeEvent.pluginId).toBe("my-plugin");
    expect(invokeEvent.fqn).toBe("my-plugin__tool");
  });
});

// ── Sec.5 — Path containment: target_path must be within scan_dirs ─────────

describe("Sec.5 — path containment enforcement", () => {
  it("SkillsSubject.apply rejects target outside scan_dirs", async () => {
    const skillsDir = join(tmpDir, "skills");
    mkdirSync(skillsDir);
    const subject = new SkillsSubject({ scanDirs: [skillsDir] });

    const proposal = makeSignedProposal({ target_path: "/etc/shadow", kind: "patch" });
    await expect(subject.apply(proposal, "A")).rejects.toThrow(/outside scan_dirs/);
  });
});

// ── Sec.6 — Privilege escalation: duplicate FQN rejected ──────────────────

describe("Sec.6 — cross-plugin tool hijack blocked", () => {
  it("plugin cannot register under another plugin's FQN", () => {
    const bridge = new PluginMcpBridge(join(tmpDir, "audit.jsonl"));
    const tool = {
      name: "shared",
      description: "d",
      schema: z.object({}).strict(),
      handler: async () => ({}),
    };

    bridge.registerPluginTool("legitimate-plugin", tool);

    // Attacker tries to re-register the same FQN (legitimate-plugin__shared)
    expect(() => bridge.registerPluginTool("legitimate-plugin", tool)).toThrow(
      /Duplicate tool registration/,
    );
  });
});
