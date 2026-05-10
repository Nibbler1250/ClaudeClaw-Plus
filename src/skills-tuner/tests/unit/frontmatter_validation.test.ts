import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsSubject } from '../../subjects/skills.js';
import { Engine } from '../../core/engine.js';
import { Registry } from '../../core/registry.js';
import { ProposalsStore } from '../../storage/proposals.js';
import { RefusedStore } from '../../storage/refused.js';
import { BranchManager } from '../../git_ops/branches.js';
import { TunableSubject } from '../../core/interfaces.js';
import { simpleGit } from 'simple-git';
import type { TunerConfig } from '../../core/config.js';
import type { Cluster, Observation, Patch, ValidationResult } from '../../core/types.js';
import type { Proposal } from '../../core/types.js';

function makeConfig(overrides: Partial<TunerConfig> = {}): TunerConfig {
  return {
    models: {
      intent_classifier: 'claude-haiku-4-5-20251001',
      detector: 'claude-haiku-4-5-20251001',
      proposer_default: 'claude-haiku-4-5-20251001',
      proposer_high_stakes: 'claude-sonnet-4-6',
      judge: 'claude-haiku-4-5-20251001',
    },
    detection: { confidence_floor: 0.6, max_proposals_per_run: 10, improvement_keywords_extra: [] },
    proposer: { alternatives_count: 2, language_preference: 'en' },
    ui: { primary_adapter: 'cli', follow_up_survey: false, follow_up_after_seconds: 3600 },
    storage: {
      proposals_jsonl: '/tmp/test-fm-p.jsonl',
      refused_jsonl: '/tmp/test-fm-r.jsonl',
      schema_version: 1,
      backup_keep: 7,
      git_repo: undefined,
    },
    llm: { backend: 'claude_cli', api_key: undefined },
    subjects: {},
    ...overrides,
  } as TunerConfig;
}

async function initGitRepo(dir: string): Promise<void> {
  const git = simpleGit(dir);
  await git.init(['-b', 'main']);
  await git.addConfig('user.email', 'test@test.com');
  await git.addConfig('user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), '# test');
  await git.add('.');
  await git.commit('initial');
}

// ── Test 1: validateFrontmatter detects missing name + missing description ──

describe('validateFrontmatter — detects missing name + description', () => {
  let dir: string;
  let subject: SkillsSubject;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fm-validate-'));
    subject = new SkillsSubject({ scanDirs: [dir] });
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  test('detects missing-name and missing-description for skill with empty frontmatter', async () => {
    const skillDir = join(dir, 'empty-skill');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\n---\n\n# Empty Skill\n\nThis is some content.\n');

    const skills = await (subject as unknown as { loadSkillsMap(): Promise<Map<string, unknown>> }).loadSkillsMap();
    const skill = [...(skills as Map<string, { path: string; frontmatter: Record<string, unknown>; format: string; content: string; triggers: string[]; dirPath: string | null }>).values()][0]!;
    const issues = subject.validateFrontmatter(skill);

    expect(issues.some(i => i.rule === 'missing-name')).toBe(true);
    expect(issues.some(i => i.rule === 'missing-description')).toBe(true);
    expect(issues.filter(i => i.severity === 'error').length).toBeGreaterThanOrEqual(2);
  });

  test('detects name-mismatch when name does not match dirname', async () => {
    const skillDir = join(dir, 'actual-dirname');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: wrong-name\ndescription: Has name but it is wrong.\n---\n\n# Content\n');

    const skills = await (subject as unknown as { loadSkillsMap(): Promise<Map<string, unknown>> }).loadSkillsMap();
    const skill = [...(skills as Map<string, { path: string; frontmatter: Record<string, unknown>; format: string; content: string; triggers: string[]; dirPath: string | null }>).values()][0]!;
    const issues = subject.validateFrontmatter(skill);

    const mismatch = issues.find(i => i.rule === 'name-mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.severity).toBe('error');
    expect(mismatch!.autofixable).toBe(true);
  });

  test('detects description-too-short as warning (not autofixable)', async () => {
    const skillDir = join(dir, 'short-desc');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: short-desc\ndescription: Too short.\n---\n\n# Content\n');

    const skills = await (subject as unknown as { loadSkillsMap(): Promise<Map<string, unknown>> }).loadSkillsMap();
    const skill = [...(skills as Map<string, { path: string; frontmatter: Record<string, unknown>; format: string; content: string; triggers: string[]; dirPath: string | null }>).values()][0]!;
    const issues = subject.validateFrontmatter(skill);

    const issue = issues.find(i => i.rule === 'description-too-short');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('warning');
    expect(issue!.autofixable).toBe(false);
  });

  test('detects legacy tuner fields', async () => {
    const skillDir = join(dir, 'legacy-skill');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: legacy-skill\ndescription: Has legacy fields that should be in config.\ntriggers: /legacy\nrisk_tier: low\n---\n\n# Legacy\n');

    const skills = await (subject as unknown as { loadSkillsMap(): Promise<Map<string, unknown>> }).loadSkillsMap();
    const skill = [...(skills as Map<string, { path: string; frontmatter: Record<string, unknown>; format: string; content: string; triggers: string[]; dirPath: string | null }>).values()][0]!;
    const issues = subject.validateFrontmatter(skill);

    const legacyIssues = issues.filter(i => i.rule === 'legacy-tuner-field');
    expect(legacyIssues.length).toBeGreaterThanOrEqual(2); // triggers + risk_tier
    expect(legacyIssues.every(i => i.autofixable)).toBe(true);
  });

  test('healthy skill with no violations returns empty issues', async () => {
    const skillDir = join(dir, 'healthy-skill');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: healthy-skill\ndescription: This skill does something useful and is at least thirty characters long.\n---\n\n# Healthy Skill\n');

    const skills = await (subject as unknown as { loadSkillsMap(): Promise<Map<string, unknown>> }).loadSkillsMap();
    const skill = [...(skills as Map<string, { path: string; frontmatter: Record<string, unknown>; format: string; content: string; triggers: string[]; dirPath: string | null }>).values()][0]!;
    const issues = subject.validateFrontmatter(skill);

    expect(issues).toHaveLength(0);
  });
});

// ── Test 2: autoFixFrontmatter fixes missing name using dirname ──

describe('autoFixFrontmatter — fixes missing name', () => {
  let dir: string;
  let subject: SkillsSubject;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fm-autofix-name-'));
    subject = new SkillsSubject({ scanDirs: [dir] });
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  test('fixes missing name using dirname and persists to disk', async () => {
    const skillDir = join(dir, 'my-skill');
    mkdirSync(skillDir);
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, '---\ndescription: This is a sufficiently long description for the skill.\n---\n\n# My Skill\n');

    const skills = await (subject as unknown as { loadSkillsMap(): Promise<Map<string, unknown>> }).loadSkillsMap();
    const skill = [...(skills as Map<string, { path: string; frontmatter: Record<string, unknown>; format: string; content: string; triggers: string[]; dirPath: string | null }>).values()][0]!;
    const issues = subject.validateFrontmatter(skill);
    expect(issues.some(i => i.rule === 'missing-name')).toBe(true);

    const result = await subject.autoFixFrontmatter(skill, issues);

    // Should have fixed missing-name
    expect(result.fixed.some(i => i.rule === 'missing-name')).toBe(true);

    // File on disk must have name: my-skill
    const content = readFileSync(skillPath, 'utf8');
    expect(content).toContain('name: my-skill');

    // Backup must exist
    const files = readdirSync(skillDir);
    const bak = files.find(f => f.includes('.pre-autofix-') && f.endsWith('.bak'));
    expect(bak).toBeTruthy();
  });

  test('fixes name-mismatch by replacing with dirname', async () => {
    const skillDir = join(dir, 'correct-dirname');
    mkdirSync(skillDir);
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, '---\nname: wrong-name\ndescription: A long description that meets the requirements here.\n---\n\n# Content\n');

    const skills = await (subject as unknown as { loadSkillsMap(): Promise<Map<string, unknown>> }).loadSkillsMap();
    const skill = [...(skills as Map<string, { path: string; frontmatter: Record<string, unknown>; format: string; content: string; triggers: string[]; dirPath: string | null }>).values()][0]!;
    const issues = subject.validateFrontmatter(skill);

    await subject.autoFixFrontmatter(skill, issues);

    const content = readFileSync(skillPath, 'utf8');
    expect(content).toContain('name: correct-dirname');
    expect(content).not.toContain('wrong-name');
  });
});

// ── Test 3: autoFixFrontmatter generates description from body heading ──

describe('autoFixFrontmatter — generates description from body', () => {
  let dir: string;
  let subject: SkillsSubject;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fm-autofix-desc-'));
    subject = new SkillsSubject({ scanDirs: [dir] });
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  test('generates description from heading + first paragraph when missing', async () => {
    const skillDir = join(dir, 'nodesc-skill');
    mkdirSync(skillDir);
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, '---\nname: nodesc-skill\n---\n\n# My Skill Heading\n\nThis paragraph has enough content to generate a description from.\n');

    const skills = await (subject as unknown as { loadSkillsMap(): Promise<Map<string, unknown>> }).loadSkillsMap();
    const skill = [...(skills as Map<string, { path: string; frontmatter: Record<string, unknown>; format: string; content: string; triggers: string[]; dirPath: string | null }>).values()][0]!;
    const issues = subject.validateFrontmatter(skill);
    expect(issues.some(i => i.rule === 'missing-description')).toBe(true);

    const result = await subject.autoFixFrontmatter(skill, issues);
    expect(result.fixed.some(i => i.rule === 'missing-description')).toBe(true);

    const content = readFileSync(skillPath, 'utf8');
    expect(content).toContain('description:');
    // Should have extracted something from the body
    expect(content.split('\n').find(l => l.startsWith('description:'))?.length).toBeGreaterThan(15);
  });

  test('leaves missing-description in remaining if body has no usable content', async () => {
    const skillDir = join(dir, 'empty-body');
    mkdirSync(skillDir);
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, '---\nname: empty-body\n---\n\n');

    const skills = await (subject as unknown as { loadSkillsMap(): Promise<Map<string, unknown>> }).loadSkillsMap();
    const skill = [...(skills as Map<string, { path: string; frontmatter: Record<string, unknown>; format: string; content: string; triggers: string[]; dirPath: string | null }>).values()][0]!;
    const issues = subject.validateFrontmatter(skill);

    const result = await subject.autoFixFrontmatter(skill, issues);
    // Should surface in remaining (not fixed) since body is empty
    const hasUnfixedDesc = result.remaining.some(i => i.rule === 'missing-description') ||
      !result.fixed.some(i => i.rule === 'missing-description');
    expect(hasUnfixedDesc).toBe(true);
  });
});

// ── Test 4: autoFixFrontmatter moves legacy trigger field to config overrides ──

describe('autoFixFrontmatter — moves legacy trigger field to config', () => {
  let dir: string;
  let subject: SkillsSubject;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fm-autofix-legacy-'));
    subject = new SkillsSubject({ scanDirs: [dir] });
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  test('strips legacy trigger field from frontmatter after autofix', async () => {
    const skillDir = join(dir, 'legacy-trigger');
    mkdirSync(skillDir);
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, '---\nname: legacy-trigger\ndescription: A sufficiently long description that meets the 30 char minimum.\ntriggers: /legacy\n---\n\n# Legacy Trigger\n');

    const skills = await (subject as unknown as { loadSkillsMap(): Promise<Map<string, unknown>> }).loadSkillsMap();
    const skill = [...(skills as Map<string, { path: string; frontmatter: Record<string, unknown>; format: string; content: string; triggers: string[]; dirPath: string | null }>).values()][0]!;
    const issues = subject.validateFrontmatter(skill);
    expect(issues.some(i => i.rule === 'legacy-tuner-field')).toBe(true);

    const result = await subject.autoFixFrontmatter(skill, issues);
    expect(result.fixed.some(i => i.rule === 'legacy-tuner-field')).toBe(true);

    // triggers field key must be gone from the SKILL.md frontmatter
    const content = readFileSync(skillPath, 'utf8');
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(fmMatch).toBeTruthy();
    // The frontmatter key 'triggers:' (the YAML field) should be removed
    const fmLines = fmMatch![1]!.split('\n');
    expect(fmLines.every(line => !line.match(/^triggers\s*:/))).toBe(true);

    // Body content must be preserved
    expect(content).toContain('# Legacy Trigger');
  });
});

// ── Test 5: apply() hook auto-fixes broken frontmatter after write ──

describe('apply() — auto-fixes frontmatter after write', () => {
  let dir: string;
  let subject: SkillsSubject;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fm-apply-hook-'));
    subject = new SkillsSubject({ scanDirs: [dir] });
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  test('apply new_skill auto-fixes missing name using dirname', async () => {
    // Content has no 'name' — apply should auto-fix it
    const contentWithoutName =
      '---\ndescription: This is a sufficiently long description for our test skill here.\n---\n\n# My Fix Skill\n\nSome content.\n';

    const proposal = {
      id: 1, cluster_id: 'c1', subject: 'skills', kind: 'new_skill',
      target_path: join(dir, '__new_entity__.md'),
      alternatives: [{ id: 'A', label: 'autofix-name-skill', diff_or_content: contentWithoutName, tradeoff: '' }],
      pattern_signature: 'sig', created_at: new Date(),
    };
    const patch = await subject.apply(proposal, 'A');

    // File exists
    expect(existsSync(patch.target_path)).toBe(true);

    // The written file should have been auto-fixed to include name
    const content = readFileSync(patch.target_path, 'utf8');
    expect(content).toContain('name:');
  });

  test('apply patch auto-fixes legacy trigger field in frontmatter', async () => {
    // Create skill in directory format
    const skillDir = join(dir, 'trigger-fix');
    mkdirSync(skillDir);
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, '---\nname: trigger-fix\ndescription: Original content before patch.\n---\n\n# Trigger Fix\n');

    const newContent =
      '---\nname: trigger-fix\ndescription: A sufficiently long description for this patched skill here.\ntriggers: /trigger-fix\n---\n\n# Trigger Fix Updated\n';

    const proposal = {
      id: 2, cluster_id: 'c2', subject: 'skills', kind: 'patch',
      target_path: skillPath,
      alternatives: [{ id: 'A', label: 'patch with legacy trigger', diff_or_content: newContent, tradeoff: '' }],
      pattern_signature: 'sig2', created_at: new Date(),
    };
    await subject.apply(proposal, 'A');

    // After apply + auto-fix, triggers field key should be removed from frontmatter
    const content = readFileSync(skillPath, 'utf8');
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(fmMatch).toBeTruthy();
    // The 'triggers:' YAML key should be gone from frontmatter
    const fmLines = fmMatch![1]!.split('\n');
    expect(fmLines.every(line => !line.match(/^triggers\s*:/))).toBe(true);
  });
});

// ── Test 6: runCycle pre-pass invokes runFrontmatterMaintenance ──

describe('engine runCycle — pre-pass invokes runFrontmatterMaintenance', () => {
  let dir: string;
  let gitDir: string;
  let proposals: ProposalsStore;
  let refused: RefusedStore;
  let branches: BranchManager;
  let registry: Registry;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fm-engine-'));
    gitDir = mkdtempSync(join(tmpdir(), 'fm-engine-git-'));
    await initGitRepo(gitDir);
    proposals = new ProposalsStore(join(dir, 'proposals.jsonl'));
    refused = new RefusedStore(join(dir, 'refused.jsonl'));
    branches = new BranchManager(gitDir);
    registry = new Registry();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
    rmSync(gitDir, { recursive: true });
  });

  test('runCycle calls runFrontmatterMaintenance on subjects that have it', async () => {
    let maintenanceCalled = false;

    class MaintenanceSubject extends TunableSubject {
      readonly name = 'maintenance-test';
      async collectObservations(_since: Date): Promise<Observation[]> { return []; }
      async detectProblems(_obs: Observation[]): Promise<Cluster[]> { return []; }
      async proposeChange(_cluster: Cluster): Promise<Proposal> {
        return { id: 0, cluster_id: 'c', subject: 'maintenance-test', kind: 'patch', target_path: '/tmp/x.md', alternatives: [{ id: 'A', label: 'x', diff_or_content: 'x', tradeoff: '' }], pattern_signature: 'sig', created_at: new Date() } as Proposal;
      }
      async apply(_p: Proposal, _a: string): Promise<Patch> { return { target_path: '/tmp/x.md', kind: 'patch', applied_content: '' }; }
      async validate(_patch: Patch): Promise<ValidationResult> { return { valid: true }; }
      async runFrontmatterMaintenance() {
        maintenanceCalled = true;
        return { total: 0, autoFixed: 0, violations: [] };
      }
    }

    registry.registerSubject(new MaintenanceSubject());
    const engine = new Engine(makeConfig(), registry, proposals, refused, branches);
    (engine as unknown as { secret: Buffer }).secret = Buffer.alloc(32);

    await engine.runCycle();

    expect(maintenanceCalled).toBe(true);
  });

  test('runCycle does not fail if runFrontmatterMaintenance throws', async () => {
    class BrokenMaintenanceSubject extends TunableSubject {
      readonly name = 'broken-maintenance';
      async collectObservations(_since: Date): Promise<Observation[]> { return []; }
      async detectProblems(_obs: Observation[]): Promise<Cluster[]> { return []; }
      async proposeChange(_cluster: Cluster): Promise<Proposal> {
        return { id: 0, cluster_id: 'c', subject: 'broken-maintenance', kind: 'patch', target_path: '/tmp/x.md', alternatives: [{ id: 'A', label: 'x', diff_or_content: 'x', tradeoff: '' }], pattern_signature: 'sig2', created_at: new Date() } as Proposal;
      }
      async apply(_p: Proposal, _a: string): Promise<Patch> { return { target_path: '/tmp/x.md', kind: 'patch', applied_content: '' }; }
      async validate(_patch: Patch): Promise<ValidationResult> { return { valid: true }; }
      async runFrontmatterMaintenance() {
        throw new Error('maintenance exploded');
      }
    }

    registry.registerSubject(new BrokenMaintenanceSubject());
    const engine = new Engine(makeConfig(), registry, proposals, refused, branches);
    (engine as unknown as { secret: Buffer }).secret = Buffer.alloc(32);

    // Should not throw
    await expect(engine.runCycle()).resolves.toBeDefined();
  });

  test('runCycle skips runFrontmatterMaintenance on subjects that do not have it', async () => {
    class NoMaintenanceSubject extends TunableSubject {
      readonly name = 'no-maintenance';
      async collectObservations(_since: Date): Promise<Observation[]> { return []; }
      async detectProblems(_obs: Observation[]): Promise<Cluster[]> { return []; }
      async proposeChange(_cluster: Cluster): Promise<Proposal> {
        return { id: 0, cluster_id: 'c', subject: 'no-maintenance', kind: 'patch', target_path: '/tmp/x.md', alternatives: [{ id: 'A', label: 'x', diff_or_content: 'x', tradeoff: '' }], pattern_signature: 'sig3', created_at: new Date() } as Proposal;
      }
      async apply(_p: Proposal, _a: string): Promise<Patch> { return { target_path: '/tmp/x.md', kind: 'patch', applied_content: '' }; }
      async validate(_patch: Patch): Promise<ValidationResult> { return { valid: true }; }
      // Note: no runFrontmatterMaintenance method
    }

    registry.registerSubject(new NoMaintenanceSubject());
    const engine = new Engine(makeConfig(), registry, proposals, refused, branches);
    (engine as unknown as { secret: Buffer }).secret = Buffer.alloc(32);

    // Should work fine without the method
    await expect(engine.runCycle()).resolves.toBeDefined();
  });
});

// ── Test 7: unsafe violations generate frontmatter-fix proposals ──

describe('detectProblems — frontmatter-fix proposal generation', () => {
  let dir: string;
  let subject: SkillsSubject;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fm-proposals-'));
    subject = new SkillsSubject({ scanDirs: [dir] });
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  test('description-too-short generates frontmatter-fix cluster with stable pattern_signature', async () => {
    const skillDir = join(dir, 'short-desc-skill');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: short-desc-skill\ndescription: Too short.\n---\n\n# Short Desc Skill\n');

    const clusters = await subject.detectProblems([]);
    const fmCluster = clusters.find(c => c.id.startsWith('frontmatter-'));
    expect(fmCluster).toBeDefined();

    const proposal = await subject.proposeChange(fmCluster!);
    expect(proposal.kind).toBe('frontmatter-fix');
    // Stable pattern_signature
    expect(proposal.pattern_signature).toBe('skills:' + join(dir, 'short-desc-skill', 'SKILL.md') + ':frontmatter-fix');
    // 3 alternatives
    expect(proposal.alternatives.length).toBeGreaterThanOrEqual(1);
    expect(proposal.alternatives.length).toBeLessThanOrEqual(3);
  });
});

// ── Test 8: proposal dedup — same sig not re-proposed ──

describe('proposal dedup — frontmatter-fix sig', () => {
  let dir: string;
  let gitDir: string;
  let proposals: ProposalsStore;
  let refused: RefusedStore;
  let branches: BranchManager;
  let registry: Registry;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fm-dedup-'));
    gitDir = mkdtempSync(join(tmpdir(), 'fm-dedup-git-'));
    await initGitRepo(gitDir);
    proposals = new ProposalsStore(join(dir, 'proposals.jsonl'));
    refused = new RefusedStore(join(dir, 'refused.jsonl'));
    branches = new BranchManager(gitDir);
    registry = new Registry();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true });
    rmSync(gitDir, { recursive: true });
  });

  test('frontmatter-fix sig already in pendingSigs is not re-proposed on second runCycle', async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), 'fm-dedup-skills-'));
    // Create a skill with description-too-short (not autofixable)
    const skillDir = join(skillsDir, 'dedup-skill');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: dedup-skill\ndescription: Too short.\n---\n\n# Dedup Skill\n');

    const skillSubject = new SkillsSubject({ scanDirs: [skillsDir] });
    registry.registerSubject(skillSubject);
    const engine = new Engine(makeConfig(), registry, proposals, refused, branches);
    (engine as unknown as { secret: Buffer }).secret = Buffer.alloc(32);

    const first = await engine.runCycle();
    // At least one frontmatter-fix proposal
    const firstRecords = proposals.readAll();
    const fmProposals = firstRecords.filter(r => r.event === 'created' && r.proposal.kind === 'frontmatter-fix');
    expect(fmProposals.length).toBeGreaterThanOrEqual(1);

    // Second run should not re-propose the same sig
    const second = await engine.runCycle();
    const secondRecords = proposals.readAll();
    const fmProposalsAfter = secondRecords.filter(r => r.event === 'created' && r.proposal.kind === 'frontmatter-fix');
    // No new frontmatter-fix proposals created
    expect(fmProposalsAfter.length).toBe(fmProposals.length);

    rmSync(skillsDir, { recursive: true });
  });
});

// ── Test 9: idempotency ──

describe('frontmatter validation — idempotency', () => {
  let dir: string;
  let subject: SkillsSubject;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fm-idempotent-'));
    subject = new SkillsSubject({ scanDirs: [dir] });
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  test('running runFrontmatterMaintenance twice on healthy corpus produces no diffs', async () => {
    // Create a perfectly compliant skill
    const skillDir = join(dir, 'healthy');
    mkdirSync(skillDir);
    const skillPath = join(skillDir, 'SKILL.md');
    const originalContent = '---\nname: healthy\ndescription: This skill does something useful and is at least thirty characters.\n---\n\n# Healthy\n\nContent.\n';
    writeFileSync(skillPath, originalContent);

    const report1 = await subject.runFrontmatterMaintenance();
    const contentAfter1 = readFileSync(skillPath, 'utf8');

    // Reset cache
    (subject as unknown as { skillsCache: null }).skillsCache = null;

    const report2 = await subject.runFrontmatterMaintenance();
    const contentAfter2 = readFileSync(skillPath, 'utf8');

    // No changes, no auto-fixes
    expect(report1.autoFixed).toBe(0);
    expect(report2.autoFixed).toBe(0);
    expect(contentAfter1).toBe(originalContent);
    expect(contentAfter2).toBe(originalContent);
  });

  test('validateFrontmatter is idempotent on healthy skill', async () => {
    const skillDir = join(dir, 'idempotent-skill');
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: idempotent-skill\ndescription: This is a perfectly compliant description with sufficient length.\n---\n\n# Idempotent\n');

    const skills = await (subject as unknown as { loadSkillsMap(): Promise<Map<string, unknown>> }).loadSkillsMap();
    const skill = [...(skills as Map<string, { path: string; frontmatter: Record<string, unknown>; format: string; content: string; triggers: string[]; dirPath: string | null }>).values()][0]!;

    const issues1 = subject.validateFrontmatter(skill);
    const issues2 = subject.validateFrontmatter(skill);

    expect(issues1).toHaveLength(0);
    expect(issues2).toHaveLength(0);
  });
});
