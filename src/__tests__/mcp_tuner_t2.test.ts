/**
 * T2 adversarial tests — sophisticated attack vectors for the skills-tuner MCP plugin.
 *
 * Covers: race conditions, replay attacks, path traversal, symlink escape, plugin isolation.
 * Uses temp dirs + real git repos for apply/revert path. Never touches production state.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { simpleGit } from "simple-git";

import { ProposalsStore } from "../../src/skills-tuner/storage/proposals.js";
import { RefusedStore } from "../../src/skills-tuner/storage/refused.js";
import { Registry } from "../../src/skills-tuner/core/registry.js";
import { Engine } from "../../src/skills-tuner/core/engine.js";
import { BranchManager } from "../../src/skills-tuner/git_ops/branches.js";
import { SkillsSubject } from "../../src/skills-tuner/subjects/skills.js";
import { PluginMcpBridge, _resetMcpBridge } from "../../src/plugins/mcp-bridge.js";
import { makeApplyTool } from "../../src/plugins/skills-tuner/tools/apply.js";
import {
  computeProposalSignature,
  loadSecret,
} from "../../src/skills-tuner/core/security.js";
import type { Proposal } from "../../src/skills-tuner/core/types.js";
import type { TunerConfig } from "../../src/skills-tuner/core/config.js";

async function initGitRepo(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "test@test.com");
  await git.addConfig("user.name", "Test");
  writeFileSync(join(dir, "README.md"), "# test");
  await git.add(".");
  await git.commit("initial");
}

function makeTmpConfig(tmpDir: string, scanDirs: string[]): TunerConfig {
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
    subjects: { skills: { enabled: true, scan_dirs: scanDirs, git_repo: tmpDir } },
  } as unknown as TunerConfig;
}

function makeSignedProposal(overrides: Partial<Proposal>): Proposal {
  const secret = loadSecret();
  const base = {
    id: 1,
    cluster_id: "cluster-t2",
    subject: "skills",
    kind: "patch",
    target_path: "/tmp/test.md",
    alternatives: [{ id: "A", label: "Fix", diff_or_content: "# Fixed", tradeoff: "" }],
    pattern_signature: "skills:/tmp/test.md:patch",
    created_at: new Date(),
    ...overrides,
  };
  const signature = computeProposalSignature(base, secret);
  return { ...base, signature };
}

let tmpDir: string;
let skillsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-t2-"));
  skillsDir = join(tmpDir, "skills");
  mkdirSync(skillsDir);
  process.env.TUNER_AUDIT_PATH = join(tmpDir, "audit.jsonl");
  _resetMcpBridge();
});

afterEach(() => {
  delete process.env.TUNER_AUDIT_PATH;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  _resetMcpBridge();
});

// ── T2.1 — concurrent apply: one succeeds, one fails ─────────────────────

describe("T2.1 — concurrent apply race condition", () => {
  it("second concurrent apply fails with 'already being applied'", async () => {
    await initGitRepo(tmpDir);
    const targetFile = join(skillsDir, "test.md");
    writeFileSync(targetFile, "# Original");

    const config = makeTmpConfig(tmpDir, [skillsDir]);
    const proposals = new ProposalsStore(config.storage.proposals_jsonl!);
    const refused = new RefusedStore(config.storage.refused_jsonl!);
    const registry = new Registry();
    registry.registerSubject(new SkillsSubject({ scanDirs: [skillsDir] }));
    const branches = new BranchManager(tmpDir);
    const engine = new Engine(config, registry, proposals, refused, branches);

    const proposal = makeSignedProposal({ id: 1, target_path: targetFile });
    proposals.append({ proposal, event: "created", ts: new Date().toISOString() });

    // Fire two concurrent applies for same proposal
    const [result1, result2] = await Promise.allSettled([
      engine.applyProposal(1, "A"),
      engine.applyProposal(1, "A"),
    ]);

    const failures = [result1, result2].filter((r) => r.status === "rejected");
    const successes = [result1, result2].filter((r) => r.status === "fulfilled");

    // At least one must succeed and at least one must fail
    expect(successes.length).toBeGreaterThanOrEqual(1);
    expect(failures.length).toBeGreaterThanOrEqual(1);

    if (failures.length > 0) {
      const err = (failures[0] as PromiseRejectedResult).reason as Error;
      expect(err.message).toMatch(/already (being applied|applied)/i);
    }
  });
});

// ── T2.2 — replay attack: second apply fails "already applied" ────────────

describe("T2.2 — replay attack (double apply)", () => {
  it("second apply on same proposal id fails", async () => {
    await initGitRepo(tmpDir);
    const targetFile = join(skillsDir, "skill.md");
    writeFileSync(targetFile, "# Original");

    const config = makeTmpConfig(tmpDir, [skillsDir]);
    const proposals = new ProposalsStore(config.storage.proposals_jsonl!);
    const refused = new RefusedStore(config.storage.refused_jsonl!);
    const registry = new Registry();
    registry.registerSubject(new SkillsSubject({ scanDirs: [skillsDir] }));
    const branches = new BranchManager(tmpDir);
    const engine = new Engine(config, registry, proposals, refused, branches);

    const proposal = makeSignedProposal({ id: 10, target_path: targetFile });
    proposals.append({ proposal, event: "created", ts: new Date().toISOString() });

    // First apply succeeds
    await engine.applyProposal(10, "A");

    // Second apply must fail
    await expect(engine.applyProposal(10, "A")).rejects.toThrow(/already applied/i);
  });
});

// ── T2.3 — path traversal via proposal target_path ────────────────────────

describe("T2.3 — path traversal rejected", () => {
  it("proposal with target_path outside scan_dirs is rejected by SkillsSubject", async () => {
    const subject = new SkillsSubject({ scanDirs: [skillsDir] });

    const proposal = makeSignedProposal({
      id: 2,
      target_path: "/etc/passwd",
      kind: "patch",
    });
    const alt = { id: "A", label: "Patch", diff_or_content: "evil content", tradeoff: "" };

    await expect(subject.apply(proposal, "A")).rejects.toThrow(/outside scan_dirs/);
  });

  it("proposal with target_path traversing up via .. is rejected", async () => {
    const subject = new SkillsSubject({ scanDirs: [skillsDir] });

    const proposal = makeSignedProposal({
      id: 3,
      target_path: join(skillsDir, "..", "..", "etc", "hosts"),
      kind: "patch",
    });

    await expect(subject.apply(proposal, "A")).rejects.toThrow(/outside scan_dirs|does not exist/);
  });
});

// ── T2.4 — symlink escape rejected by realpath guard ─────────────────────

describe("T2.4 — symlink escape protection", () => {
  it("symlink pointing outside scan_dirs is rejected", async () => {
    // Create a target file outside scan_dirs
    const outsideFile = join(tmpDir, "outside_target.md");
    writeFileSync(outsideFile, "# Secret content");

    // Create a symlink inside scan_dirs pointing to the outside file
    const symlinkPath = join(skillsDir, "innocent.md");
    symlinkSync(outsideFile, symlinkPath);
    expect(existsSync(symlinkPath)).toBe(true);

    const subject = new SkillsSubject({ scanDirs: [skillsDir] });
    const proposal = makeSignedProposal({
      id: 4,
      target_path: symlinkPath,
      kind: "patch",
    });

    // Should reject because realpath of symlinkPath resolves to outsideFile,
    // which is not within skillsDir
    await expect(subject.apply(proposal, "A")).rejects.toThrow(/symlink resolves outside scan_dirs|outside scan_dirs/);
  });
});

// ── T2.5 — stdin/stdout discipline (MCP stream purity) ───────────────────

describe("T2.5 — MCP stream purity", () => {
  it("bridge invokeTool does not write to process.stdout or process.stderr", async () => {
    const bridge = new PluginMcpBridge(join(tmpDir, "audit.jsonl"));
    const { z } = await import("zod");
    bridge.registerPluginTool("test", {
      name: "noop",
      description: "noop",
      schema: z.object({}).strict(),
      handler: () => ({ ok: true }),
    });

    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const stdoutCalls: unknown[] = [];
    const stderrCalls: unknown[] = [];

    process.stdout.write = (...args: unknown[]) => {
      stdoutCalls.push(args[0]);
      return originalStdoutWrite(...(args as Parameters<typeof originalStdoutWrite>));
    };
    process.stderr.write = (...args: unknown[]) => {
      stderrCalls.push(args[0]);
      return originalStderrWrite(...(args as Parameters<typeof originalStderrWrite>));
    };

    try {
      await bridge.invokeTool("test__noop", {});
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    expect(stdoutCalls.length).toBe(0);
    expect(stderrCalls.length).toBe(0);
  });
});

// ── T2.6 — plugin namespace isolation ─────────────────────────────────────

describe("T2.6 — plugin namespace isolation", () => {
  it("registering duplicate FQN from different plugin throws", () => {
    const bridge = new PluginMcpBridge(join(tmpDir, "audit.jsonl"));
    const { z } = require("zod");
    const tool = { name: "pending", description: "d", schema: z.object({}).strict(), handler: async () => ({}) };

    bridge.registerPluginTool("plugin-a", tool);

    // Same tool name, same pluginId → duplicate FQN
    expect(() => bridge.registerPluginTool("plugin-a", tool)).toThrow(/Duplicate tool registration/);
  });

  it("same tool name from different plugin ids gets distinct FQNs", () => {
    const bridge = new PluginMcpBridge(join(tmpDir, "audit.jsonl"));
    const { z } = require("zod");
    const tool = { name: "pending", description: "d", schema: z.object({}).strict(), handler: async () => ({}) };

    bridge.registerPluginTool("plugin-a", tool);
    bridge.registerPluginTool("plugin-b", { ...tool }); // different pluginId → different FQN

    const tools = bridge.listTools().map((t) => t.fqn);
    expect(tools).toContain("plugin-a__pending");
    expect(tools).toContain("plugin-b__pending");
  });
});
