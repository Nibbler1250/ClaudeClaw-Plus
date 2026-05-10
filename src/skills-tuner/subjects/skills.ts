import { writeFile, copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { BaseSubject } from './base.js';
import { sanitizeObservationContent, auditLog } from '../core/security.js';
import { ORPHAN_SUBJECT, CREATE_KINDS } from '../core/interfaces.js';
import type { FrontmatterIssue, FrontmatterMaintenanceReport } from '../core/interfaces.js';
import type { Cluster, Observation, Patch, Proposal, UnsignedProposal, ValidationResult } from '../core/types.js';
import type { LLMClient } from '../core/llm.js';

export const DEFAULT_NEGATIVE_PATTERNS: RegExp[] = [
  /\bnope\b/i, /\bwrong\b/i, /not right/i, /try again/i,
  /\bno\b/i, /that's not/i, /i don't like/i, /frustrat/i, /not what i/i,
  /\bnon\b/i, /pas comme/i, /c'est pas/i, /recommence/i, /oublie/i,
];
export const DEFAULT_POSITIVE_PATTERNS: RegExp[] = [
  /\bperfect\b/i, /\bnice\b/i, /\bexactly\b/i, /\bgood\b/i,
  /\bthanks\b/i, /\bgreat\b/i, /that.*right/i, /that.*works/i,
  /\bparfait\b/i, /\bmerci\b/i, /c'est bon/i, /bien fait/i,
];
export const DEFAULT_EMOTIONAL_PATTERNS: RegExp[] = [
  /\bmoney\b/i, /\bcash\b/i, /at stake/i,
  /\bdamn\b/i, /\bhell\b/i, /\bfuck\b/i, /\bshit\b/i,
  /\bbroken\b/i, /frustrating/i, /\bangry\b/i,
];

export const ORPHAN_SKILL = ORPHAN_SUBJECT;

export interface SkillEntry {
  path: string;
  dirPath: string | null;           // set for directory format, null for flat
  format: 'flat' | 'directory';
  frontmatter: Record<string, unknown>;
  content: string;
  triggers: string[];               // resolved: config overrides > frontmatter > name
}

export interface SkillOverride {
  triggers?: string[];
  risk_tier?: string;
  auto_merge_default?: boolean;
}

export interface SkillsSubjectConfig {
  llm?: LLMClient;
  scanDirs?: string[];
  emotionalPatterns?: RegExp[];
  negativePatterns?: RegExp[];
  positivePatterns?: RegExp[];
  /** Language hint for LLM-generated labels and tradeoffs. e.g. 'fr-quebec', 'en'. Defaults to 'en'. */
  language?: string;
  // Skills-tuner-specific metadata for Anthropic-format skills (no frontmatter pollution)
  overrides?: Record<string, SkillOverride>;
}

function combineRegex(patterns: RegExp[]): RegExp {
  return new RegExp(patterns.map(p => p.source).join('|'), 'i');
}

function stripFences(text: string): string {
  text = text.trim();
  if (text.startsWith('```')) {
    text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : text.slice(3);
    if (text.endsWith('```')) text = text.slice(0, text.lastIndexOf('```'));
  }
  return text.trim();
}

/**
 * Robustly extract a JSON array from an LLM response that may contain prose,
 * markdown, or fenced code blocks before/after the JSON. Picks the substring
 * from the first "[" to the last "]" so JSON.parse gets a clean array even if
 * the model prepended a chain-of-thought or diagnosis.
 */
function extractJsonArray(text: string): string {
  const stripped = stripFences(text);
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return stripped;
  return stripped.slice(start, end + 1);
}


export class SkillsSubject extends BaseSubject {
  readonly name = 'skills';
  readonly risk_tier = 'low' as const;
  readonly auto_merge_default = true;
  readonly supports_creation = true;
  readonly orphan_min_observations = 2;

  private readonly llm?: LLMClient;
  private readonly scanDirs: string[];
  private readonly negRe: RegExp;
  private readonly posRe: RegExp;
  private readonly emotRe: RegExp;
  private readonly overrides: Record<string, SkillOverride>;
  private readonly language: string;
  private skillsCache: Map<string, SkillEntry> | null = null;

  constructor(opts: SkillsSubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    this.scanDirs = opts.scanDirs ?? [join(homedir(), 'agent', 'skills')];
    this.negRe = combineRegex(opts.negativePatterns ?? DEFAULT_NEGATIVE_PATTERNS);
    this.posRe = combineRegex(opts.positivePatterns ?? DEFAULT_POSITIVE_PATTERNS);
    this.emotRe = combineRegex(opts.emotionalPatterns ?? DEFAULT_EMOTIONAL_PATTERNS);
    this.overrides = opts.overrides ?? {};
    this.language = opts.language ?? 'en';
  }

  async collectObservations(since: Date): Promise<Observation[]> {
    const skills = await this.loadSkillsMap();
    if (skills.size === 0) return [];

    const observations: Observation[] = [];
    const sessionFiles = await this.findSessionFiles(since);

    for (const filePath of sessionFiles) {
      try {
        const obs = await this.scanSession(filePath, skills, since);
        observations.push(...obs);
      } catch {
        // skip unreadable session
      }
    }
    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    const clusters: Cluster[] = [];

    if (observations.length > 0) {
      const bySkill = new Map<string, Observation[]>();
      for (const obs of observations) {
        const skillName = (obs.metadata?.['skill_name'] as string | undefined) ?? 'unknown';
        const list = bySkill.get(skillName) ?? [];
        list.push(obs);
        bySkill.set(skillName, list);
      }

      const now = new Date().toISOString().slice(0, 10).replace(/-/g, '');

      for (const [skillName, obsList] of bySkill) {
        if (skillName === ORPHAN_SKILL) {
          if (obsList.length >= this.orphan_min_observations) {
            clusters.push({
              id: 'skills-' + ORPHAN_SKILL + '-' + now,
              subject: 'skills',
              observations: obsList,
              frequency: obsList.length,
              success_rate: 0,
              sentiment: 'negative',
              subjects_touched: [ORPHAN_SKILL],
            });
          }
          continue;
        }

        const neg = obsList.filter(o => o.signal_type !== 'positive_feedback');
        const pos = obsList.filter(o => o.signal_type === 'positive_feedback');
        const total = obsList.length;
        const successRate = total > 0 ? pos.length / total : 0;
        const frequency = neg.length;

        if (frequency < 2) continue;
        if (successRate > 0.8) continue;

        clusters.push({
          id: 'skills-' + skillName + '-' + now,
          subject: 'skills',
          observations: obsList,
          frequency,
          success_rate: successRate,
          sentiment: successRate < 0.3 ? 'negative' : 'neutral',
          subjects_touched: [skillName],
        });
      }

      clusters.sort((a, b) => b.frequency - a.frequency);
    }

    // Yield synthetic clusters for non-autofixable frontmatter violations
    // (autofixable ones are handled in runFrontmatterMaintenance pre-pass)
    const skills = await this.loadSkillsMap();
    for (const skill of skills.values()) {
      const issues = this.validateFrontmatter(skill);
      const unsafe = issues.filter(i => !i.autofixable);
      if (unsafe.length === 0) continue;
      const skillName = (skill.frontmatter['name'] as string | undefined) ??
        (skill.format === 'directory' ? basename(dirname(skill.path)) : basename(skill.path, '.md'));
      // Encode frontmatter issue info in synthetic observation metadata
      const syntheticObs: Observation = {
        session_id: 'frontmatter-maintenance',
        observed_at: new Date(),
        signal_type: 'correction',
        verbatim: 'frontmatter-fix:' + unsafe.map(i => i.rule).join(','),
        metadata: {
          skill_name: skillName,
          frontmatter_issues: JSON.stringify(unsafe),
          skill_path: skill.path,
          cluster_kind: 'frontmatter-fix',
        },
      };
      clusters.push({
        id: 'frontmatter-' + skillName,
        subject: 'skills',
        observations: [syntheticObs],
        frequency: unsafe.length,
        success_rate: 0,
        sentiment: 'negative',
        subjects_touched: [skillName],
      });
    }

    return clusters;
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const skillName = cluster.subjects_touched[0] ?? 'unknown';
    // Detect frontmatter-fix synthetic cluster by inspecting first observation metadata
    const firstObsMeta = cluster.observations[0]?.metadata;
    if (firstObsMeta?.['cluster_kind'] === 'frontmatter-fix') {
      return this.proposeFrontmatterFix(cluster, skillName);
    }
    if (skillName === ORPHAN_SKILL) {
      return this.proposeNewSkill(cluster);
    }
    return this.proposePatchForExistingSkill(cluster, skillName);
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    const alt = proposal.alternatives.find(a => a.id === alternativeId);
    if (!alt) throw new Error('Alternative ' + alternativeId + ' not found');

    const expandHome = (p: string) => p.replace(/^~/, homedir());
    const allowed = this.scanDirs.map(d => resolve(expandHome(d)));

    if (CREATE_KINDS.has(proposal.kind as never)) {
      const slug = (alt.label.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/, '') || 'new-skill');
      const baseDir = resolve(expandHome(this.scanDirs[0]!));

      // Default to directory format (Anthropic standard)
      let actualDir = resolve(baseDir, slug);
      let target = join(actualDir, 'SKILL.md');

      // Collision: append timestamp
      if (existsSync(actualDir)) {
        const ts = Math.floor(Date.now() / 1000);
        actualDir = actualDir + '-' + ts;
        target = join(actualDir, 'SKILL.md');
      }

      // Path containment guard
      const targetReal = resolve(target);
      if (!allowed.some(d => targetReal === d || targetReal.startsWith(d + sep) || targetReal.startsWith(d + '/'))) {
        throw new Error('Target ' + targetReal + ' outside scan_dirs');
      }

      await mkdir(actualDir, { recursive: true });
      await writeFile(target, alt.diff_or_content, 'utf8');
      this.skillsCache = null;

      // Post-write frontmatter validation + auto-fix
      await this.postWriteFrontmatterFix(target);

      return { target_path: target, kind: proposal.kind, applied_content: alt.diff_or_content };
    }

    const target = resolve(expandHome(proposal.target_path));
    if (!allowed.some(d => target.startsWith(d + sep) || target.startsWith(d + '/') || target === d)) {
      throw new Error('Target ' + target + ' outside scan_dirs');
    }
    if (!existsSync(target)) {
      throw new Error('Target ' + target + ' does not exist for kind=' + proposal.kind);
    }
    await copyFile(target, target + '.bak');
    await writeFile(target, alt.diff_or_content, 'utf8');
    this.skillsCache = null;

    // Post-write frontmatter validation + auto-fix
    await this.postWriteFrontmatterFix(target);

    return { target_path: target, kind: proposal.kind, applied_content: alt.diff_or_content };
  }

  /**
   * After writing a SKILL.md file, load it as a SkillEntry, validate frontmatter,
   * and auto-fix safe violations inline.
   */
  private async postWriteFrontmatterFix(filePath: string): Promise<void> {
    try {
      const { frontmatter, body } = await this.loadFrontmatter(filePath);
      const isDir = filePath.endsWith('SKILL.md');
      const skill: SkillEntry = {
        path: filePath,
        dirPath: isDir ? dirname(filePath) : null,
        format: isDir ? 'directory' : 'flat',
        frontmatter,
        content: body,
        triggers: [],
      };
      const issues = this.validateFrontmatter(skill);
      if (issues.length > 0) {
        await this.autoFixFrontmatter(skill, issues);
      }
    } catch {
      // Post-write fix is best-effort — never fail the apply
    }
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    if (CREATE_KINDS.has(patch.kind as never)) {
      const content = patch.applied_content ?? '';
      if (!content.startsWith('---')) {
        return { valid: false, reason: 'Created skill missing frontmatter' };
      }
      const fm = content.split('---')[1] ?? '';
      if (!fm.includes('name:')) {
        return { valid: false, reason: 'Created skill missing name: in frontmatter (Anthropic format requires name)' };
      }
      if (!fm.includes('description:')) {
        return { valid: false, reason: 'Created skill missing description: in frontmatter (Anthropic format requires description for discovery)' };
      }
      // Note: triggers: is optional — configure in ~/.config/tuner/config.yaml under subjects.skills.overrides
    }
    return { valid: true };
  }

  scoreSignal(verbatim: string, attributedTo: string, knownEntities: Record<string, unknown>): number {
    const textLower = verbatim.toLowerCase();
    const triggersMatched = new Set<string>();
    for (const [name, info] of Object.entries(knownEntities)) {
      const triggers: string[] = (info as { triggers?: string[] } | null)?.triggers ?? [name];
      for (const trigger of triggers) {
        if (textLower.includes(trigger.toLowerCase())) {
          triggersMatched.add(name);
          break;
        }
      }
    }
    let score = 0;
    if (triggersMatched.has(attributedTo)) score += 2;
    const others = [...triggersMatched].filter(n => n !== attributedTo);
    if (others.length > 0) score -= 3;
    if (triggersMatched.size === 0 && this.emotRe.test(verbatim)) score -= 1;
    return score;
  }

  reclassifySignal(verbatim: string, knownEntities: Record<string, unknown>): string {
    const textLower = verbatim.toLowerCase();
    for (const [name, info] of Object.entries(knownEntities)) {
      const triggers: string[] = (info as { triggers?: string[] } | null)?.triggers ?? [name];
      for (const trigger of triggers) {
        if (textLower.includes(trigger.toLowerCase())) return name;
      }
    }
    return ORPHAN_SUBJECT;
  }

  // ── Private helpers ──

  private async loadSkillsMap(): Promise<Map<string, SkillEntry>> {
    if (this.skillsCache) return this.skillsCache;
    const map = new Map<string, SkillEntry>();

    for (const dir of this.scanDirs) {
      const expanded = dir.replace(/^~/, homedir());
      if (!existsSync(expanded)) continue;

      let entries;
      try {
        entries = await readdir(expanded, { withFileTypes: true });
      } catch { continue; }

      // Pass 1: directory format (Anthropic standard — higher priority)
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = join(expanded, entry.name, 'SKILL.md');
        if (!existsSync(skillMdPath)) continue;
        const { frontmatter, body } = await this.loadFrontmatter(skillMdPath);
        const name = (frontmatter['name'] as string | undefined) ?? entry.name;
        const configOverride = this.overrides[name]?.triggers;
        const triggers = Array.isArray(configOverride) ? configOverride : this.parseTriggers(frontmatter, name);
        map.set(name, {
          path: skillMdPath,
          dirPath: join(expanded, entry.name),
          format: 'directory',
          frontmatter,
          content: body,
          triggers,
        });
      }

      // Pass 2: flat format — skipped if directory format already loaded for same name
      for (const entry of entries) {
        if (entry.isDirectory() || !entry.name.endsWith('.md') || entry.name.includes('.bak')) continue;
        const filePath = join(expanded, entry.name);
        const { frontmatter, body } = await this.loadFrontmatter(filePath);
        const name = (frontmatter['name'] as string | undefined) ?? entry.name.replace(/\.md$/, '');
        if (map.has(name)) continue; // directory format wins
        const configOverride = this.overrides[name]?.triggers;
        const triggers = Array.isArray(configOverride) ? configOverride : this.parseTriggers(frontmatter, name);
        map.set(name, {
          path: filePath,
          dirPath: null,
          format: 'flat',
          frontmatter,
          content: body,
          triggers,
        });
      }
    }

    this.skillsCache = map;
    return map;
  }

  private parseTriggers(frontmatter: Record<string, unknown>, fallback: string): string[] {
    const raw = frontmatter['triggers'] ?? frontmatter['trigger'];
    if (typeof raw === 'string') return raw.split(',').map(t => t.trim()).filter(Boolean);
    if (Array.isArray(raw)) return raw.map(String);
    return [fallback];
  }

  private matchSkill(text: string, skills: Map<string, { triggers: string[] }>): string | null {
    const textLower = text.toLowerCase();
    for (const [name, info] of skills) {
      for (const trigger of info.triggers) {
        if (textLower.includes(trigger.toLowerCase())) return name;
      }
    }
    return null;
  }

  private async findSessionFiles(since: Date): Promise<string[]> {
    const files: string[] = [];

    const home = homedir();
    const projectsDir = join(home, '.claude', 'projects');
    if (existsSync(projectsDir)) {
      try {
        const projects = await readdir(projectsDir, { withFileTypes: true });
        for (const project of projects) {
          if (!project.isDirectory()) continue;
          const projectPath = join(projectsDir, project.name);
          const direct = await readdir(projectPath).catch(() => [] as string[]);
          for (const f of direct) {
            if (f.endsWith('.jsonl')) files.push(join(projectPath, f));
          }
          const sessionsPath = join(projectPath, 'sessions');
          if (existsSync(sessionsPath)) {
            const sesFiles = await readdir(sessionsPath).catch(() => [] as string[]);
            for (const f of sesFiles) {
              if (f.endsWith('.jsonl')) files.push(join(sessionsPath, f));
            }
          }
        }
      } catch { /* skip */ }
    }

    const sinceMs = since.getTime();
    return files
      .filter(f => {
        try { return statSync(f).mtimeMs >= sinceMs; } catch { return false; }
      })
      .map(f => { try { return { f, mtime: statSync(f).mtimeMs }; } catch { return { f, mtime: 0 }; } })
      .sort((a, b) => b.mtime - a.mtime)
      .map(x => x.f)
      .slice(0, 50);
  }

  private async scanSession(filePath: string, skills: Map<string, SkillEntry>, since: Date): Promise<Observation[]> {
    const observations: Observation[] = [];
    const messages: Array<Record<string, unknown>> = [];

    const rl = createInterface({ input: createReadStream(filePath, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { messages.push(JSON.parse(line) as Record<string, unknown>); } catch { /* skip */ }
    }

    const sessionId = basename(filePath, '.jsonl');

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (msg['type'] !== 'user') continue;
      const text = this.extractText(msg);
      if (!text) continue;

      const matchedSkill = this.matchSkill(text, skills);
      if (!matchedSkill) continue;

      let nextUserText = '';
      for (let j = i + 1; j < Math.min(i + 5, messages.length); j++) {
        if (messages[j]!['type'] === 'user') {
          nextUserText = this.extractText(messages[j]!) ?? '';
          break;
        }
      }

      const ts = this.parseTs(msg);
      const skillsAsEntities: Record<string, unknown> = {};
      for (const [k, v] of skills) skillsAsEntities[k] = { triggers: v.triggers };

      if (nextUserText && this.negRe.test(nextUserText)) {
        const score = this.scoreSignal(nextUserText, matchedSkill, skillsAsEntities);
        const attributed = score < 0 ? this.reclassifySignal(nextUserText, skillsAsEntities) : matchedSkill;
        observations.push({
          session_id: sessionId,
          observed_at: ts,
          signal_type: 'correction',
          verbatim: sanitizeObservationContent(nextUserText.slice(0, 200)),
          metadata: { skill_name: attributed, trigger: text.slice(0, 100) },
        });
      } else if (nextUserText && this.posRe.test(nextUserText)) {
        observations.push({
          session_id: sessionId,
          observed_at: ts,
          signal_type: 'positive_feedback',
          verbatim: sanitizeObservationContent(nextUserText.slice(0, 200)),
          metadata: { skill_name: matchedSkill },
        });
      }
    }
    return observations;
  }

  private extractText(msg: Record<string, unknown>): string | null {
    try {
      const content = (msg['message'] as Record<string, unknown> | undefined)?.['content'];
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const parts = (content as Array<Record<string, unknown>>)
          .filter(c => c['type'] === 'text')
          .map(c => String(c['text'] ?? ''));
        return parts.join(' ') || null;
      }
    } catch { /* skip */ }
    return null;
  }

  private parseTs(msg: Record<string, unknown>): Date {
    const ts = msg['timestamp'];
    if (typeof ts === 'string') {
      try { return new Date(ts); } catch { /* fall through */ }
    }
    return new Date();
  }

  private async proposeFrontmatterFix(cluster: Cluster, skillName: string): Promise<UnsignedProposal> {
    const obsMeta = cluster.observations[0]?.metadata ?? {};
    let issues: FrontmatterIssue[] = [];
    try {
      issues = JSON.parse(obsMeta['frontmatter_issues'] as string ?? '[]') as FrontmatterIssue[];
    } catch { issues = []; }
    const skillPath = (obsMeta['skill_path'] as string | undefined) ?? join(this.scanDirs[0]!.replace(/^~/, homedir()), skillName, 'SKILL.md');

    // Stable pattern_signature: skills:<absolute_path>:frontmatter-fix
    const patternSignature = 'skills:' + skillPath + ':frontmatter-fix';

    let alternatives: Array<{ id: string; label: string; diff_or_content: string; tradeoff: string }>;

    if (this.llm) {
      try {
        const issueList = issues.map(i => `- ${i.rule}: ${i.details ?? ''}`).join('\n');
        // Read current skill content for context
        let currentContent = '';
        try { currentContent = await readFile(skillPath, 'utf8'); } catch { /* skip */ }
        const system =
          'You are fixing frontmatter compliance issues in a Claude Code skill (SKILL.md). ' +
          'The violations listed are non-autofixable and require human judgment (e.g. writing a better description). ' +
          'Propose 3 concrete alternatives that resolve the violations while preserving the skill body. ' +
          'Each diff_or_content must be the COMPLETE revised SKILL.md content. ' +
          'Reply ONLY with a JSON array of 3 objects: [{"id":"A","label":"...","diff_or_content":"...","tradeoff":"..."}, ...]. ' +
          'The VERY FIRST character of your reply MUST be "[". ' +
          'Write label and tradeoff in ' + this.language + '.';
        const user =
          'Skill: ' + skillName + '\n' +
          'Violations:\n' + issueList + '\n\n' +
          'Current content:\n```\n' + currentContent.slice(0, 3000) + '\n```\n\n' +
          'Propose 3 alternatives that fix the violations.';
        const raw = await this.llm.call('proposer', system, [{ role: 'user', content: user }], 4000);
        const data = JSON.parse(extractJsonArray(raw)) as Array<{ id: string; label: string; diff_or_content: string; tradeoff?: string }>;
        alternatives = data.slice(0, 3).map(a => ({ id: a.id, label: a.label, diff_or_content: a.diff_or_content, tradeoff: a.tradeoff ?? '' }));
      } catch {
        alternatives = this.fallbackFrontmatterAlternatives(skillName, issues);
      }
    } else {
      alternatives = this.fallbackFrontmatterAlternatives(skillName, issues);
    }

    return {
      id: 0,
      cluster_id: cluster.id,
      subject: 'skills',
      kind: 'frontmatter-fix',
      target_path: skillPath,
      alternatives,
      pattern_signature: patternSignature,
      created_at: new Date(),
    };
  }

  private fallbackFrontmatterAlternatives(
    skillName: string,
    issues: FrontmatterIssue[],
  ): Array<{ id: string; label: string; diff_or_content: string; tradeoff: string }> {
    const issueDesc = issues.map(i => i.rule).join(', ');
    const placeholder =
      '---\nname: ' + skillName + '\ndescription: Describe what this skill does and when to use it (at least 30 characters).\n---\n\n# ' + skillName + '\n\nAdd skill content here.\n';
    return [
      { id: 'A', label: 'Add minimal compliant description', diff_or_content: placeholder, tradeoff: 'Fixes ' + issueDesc + '; description is a placeholder' },
      { id: 'B', label: 'Same — placeholder description variant 2', diff_or_content: placeholder, tradeoff: 'Fixes ' + issueDesc + '; customize description' },
      { id: 'C', label: 'Same — placeholder description variant 3', diff_or_content: placeholder, tradeoff: 'Fixes ' + issueDesc + '; customize description' },
    ];
  }

  private async proposeNewSkill(cluster: Cluster): Promise<UnsignedProposal> {
    const evidence = cluster.observations.slice(0, 6).map(o => '- ' + sanitizeObservationContent(o.verbatim)).join('\n');
    const targetPath = join(this.scanDirs[0]!.replace(/^~/, homedir()), ORPHAN_SKILL + '.md');

    const alternatives = this.llm
      ? await this.llmProposeNewSkill(evidence, cluster).catch(err => {
          console.warn('[skills-tuner] llmProposeNewSkill failed, using fallback:', (err as Error).message?.slice(0, 200));
          return this.fallbackNewSkillAlternatives();
        })
      : this.fallbackNewSkillAlternatives();

    // pattern_signature must be stable across days so refused proposals
    // remain deduped. Hash the first observations' verbatim so distinct
    // orphan needs (different verbatims) get distinct signatures, but the
    // same orphan need on different days collapses to one signature.
    const orphanContentHash = createHash('sha256')
      .update(cluster.observations.slice(0, 5).map(o => o.verbatim).join('|'))
      .digest('hex').slice(0, 16);
    return {
      id: 0,
      cluster_id: cluster.id,
      subject: 'skills',
      kind: 'new_skill',
      target_path: targetPath,
      alternatives,
      pattern_signature: 'skills:' + ORPHAN_SKILL + ':new_skill:' + orphanContentHash,
      created_at: new Date(),
    };
  }

  private async proposePatchForExistingSkill(cluster: Cluster, skillName: string): Promise<UnsignedProposal> {
    const skills = await this.loadSkillsMap();
    const skillInfo = skills.get(skillName);
    const skillPath = skillInfo?.path ?? join(this.scanDirs[0]!, skillName + '.md');
    const rawSkillContent = skillInfo?.content ?? '(content not found)';
    const skillContent = sanitizeObservationContent(rawSkillContent, 10_000);
    const evidence = cluster.observations.slice(0, 6)
      .map(o => '- [' + o.signal_type + '] ' + sanitizeObservationContent(o.verbatim)).join('\n');

    const alternatives = this.llm
      ? await this.llmPropose(skillName, skillContent, evidence, cluster).catch(err => {
          console.warn('[skills-tuner] llmPropose failed, using fallback:', (err as Error).message?.slice(0, 200));
          return this.fallbackAlternatives(skillName, skillInfo);
        })
      : this.fallbackAlternatives(skillName, skillInfo);

    return {
      id: 0,
      cluster_id: cluster.id,
      subject: 'skills',
      kind: 'patch',
      target_path: skillPath,
      alternatives,
      // Stable across days: same skillPath + same kind = same signature.
      // Previously included cluster.id which embeds the date (skills-foo-20260509),
      // making refused dedup fail every midnight.
      pattern_signature: 'skills:' + skillPath + ':patch',
      created_at: new Date(),
    };
  }

  private async llmProposeNewSkill(evidence: string, cluster: Cluster) {
    const system =
      "You are creating a NEW Claude Code skill (SKILL.md) in Anthropic directory format because the user is repeatedly hitting a need that no existing skill covers.\n" +
      "\n" +
      "Procedure:\n" +
      "1. Classify the unmet need into exactly one category: recurring-workflow-gap | missing-tool-integration | context-accumulation-need | automation-gap | output-format-need | discovery-shortcut. State the category and the implicit need in one sentence.\n" +
      "2. Propose 3 distinct skill templates that address the gap classification. Each must take a structurally DIFFERENT angle (e.g. one minimal/declarative, one with explicit step-by-step instructions, one with structured output schema). Reject cosmetic variants — \"shorter version of A\" or header-only changes do NOT count as different angles.\n" +
      "3. Each label must describe the skill's behavior (e.g. 'Schedule + emit reminder at fixed time'), not its shape ('Concise version').\n" +
      "4. Each tradeoff must state the strength + the concrete cost or risk (e.g. 'Less brittle but requires explicit time argument').\n" +
      "\n" +
      "Constraints:\n" +
      "- Frontmatter MUST contain only 'name' and 'description' fields. Do NOT include triggers, risk_tier, schedule, or other custom fields — those live in the user config.\n" +
      "- 'description' must start with what the skill does and when to use it (the skill matcher reads descriptions to pick which skills to load).\n" +
      "- diff_or_content must be the COMPLETE SKILL.md contents.\n" +
      "- Reply ONLY with a JSON array of 3 objects: [{\"id\":\"A\",\"label\":\"...\",\"diff_or_content\":\"...\",\"tradeoff\":\"...\"}, ...]. The VERY FIRST character of your reply MUST be \"[\" — no prose or markdown before the array. Embed the gap classification inside the first alternative's label or tradeoff, not as a preamble.\n" +
      "- Write 'label' and 'tradeoff' in " + this.language + ".";
    const user =
      "Unattributed user signals (" + cluster.frequency + " occurrences, sentiment=" + cluster.sentiment + "):\n" +
      evidence + "\n\n" +
      "Identify the implicit need and embed it in the first alternative's label or tradeoff. Propose 3 skill templates that take different angles.";
    const raw = await this.llm!.call('proposer', system, [{ role: 'user', content: user }], 4000);
    const data = JSON.parse(extractJsonArray(raw)) as Array<{ id: string; label: string; diff_or_content: string; tradeoff?: string }>;
    return data.slice(0, 3).map(a => ({ id: a.id, label: a.label, diff_or_content: a.diff_or_content, tradeoff: a.tradeoff ?? '' }));
  }

  private async llmPropose(skillName: string, skillContent: string, evidence: string, cluster: Cluster) {
    const system =
      "You are improving a Claude Code skill (markdown with YAML frontmatter) using user feedback. Goal: address the SPECIFIC failure mode shown in the signals — not generic refactoring.\n" +
      "\n" +
      "Procedure:\n" +
      "1. Diagnose the failure pattern from the signals. Pick one of: wrong-trigger, vague-instructions, missing-edge-case, wrong-tool-selection, ambiguous-output, over-eager-activation, under-specified-scope, format-mismatch.\n" +
      "2. Propose 3 alternatives that EACH address the diagnosis with a DIFFERENT strategy. Reject cosmetic-only variants (whitespace, header reordering, copy with minor tweaks).\n" +
      "3. Each label must describe the change ('Disambiguate target device before action'), not the form ('Concise version').\n" +
      "4. Each tradeoff must explicitly state what becomes better and what new risk this introduces (e.g. 'Reduces over-eager triggers but adds an extra disambiguation turn').\n" +
      "\n" +
      "Constraints:\n" +
      "- Preserve YAML frontmatter (name, description, etc.) unless the diagnosis requires editing it.\n" +
      "- diff_or_content must be the COMPLETE revised skill content (full file ready to write to disk).\n" +
      "- Reply ONLY with a JSON array of 3 objects: [{\"id\":\"A\",\"label\":\"...\",\"diff_or_content\":\"...\",\"tradeoff\":\"...\"}, ...]. The VERY FIRST character of your reply MUST be \"[\" — no prose, no diagnosis text, no markdown before the array. Embed the diagnosis inside each label or tradeoff, not as a preamble.\n" +
      "- Write 'label' and 'tradeoff' in " + this.language + ".";
    const user =
      "Skill name: " + skillName + "\n" +
      "Negative user signals (frequency=" + cluster.frequency + ", sentiment=" + cluster.sentiment + "):\n" +
      evidence + "\n\n" +
      "Current skill content:\n```\n" + skillContent.slice(0, 3000) + "\n```\n\n" +
      "First, identify the failure pattern in one sentence. Then propose 3 behavior-changing alternatives.";
    const raw = await this.llm!.call('proposer', system, [{ role: 'user', content: user }], 4000);
    const data = JSON.parse(extractJsonArray(raw)) as Array<{ id: string; label: string; diff_or_content: string; tradeoff?: string }>;
    return data.slice(0, 3).map(a => ({ id: a.id, label: a.label, diff_or_content: a.diff_or_content, tradeoff: a.tradeoff ?? '' }));
  }

  private fallbackNewSkillAlternatives() {
    // Anthropic standard format: name + description in frontmatter, no triggers (go in config)
    return [
      { id: 'A', label: 'new-skill', diff_or_content: '---\nname: new-skill\ndescription: Describe what this skill does and when to use it. This description is used by Claude Code skill matcher.\n---\n\n# New Skill\n\nDescribe the skill here.\n', tradeoff: 'Minimal Anthropic-format starting point' },
      { id: 'B', label: 'system-monitor', diff_or_content: '---\nname: system-monitor\ndescription: Check the state of services, disk usage, and system health. Use when asked about infrastructure status.\n---\n\n# System Monitor\n\nCheck the state of services.\n', tradeoff: 'Useful if signals relate to infra' },
      { id: 'C', label: 'assistant-context', diff_or_content: '---\nname: assistant-context\ndescription: Provides context about the assistant persona, preferences, and collaboration style. Use for onboarding or preference discussions.\n---\n\n# Assistant Context\n\nContext about the assistant.\n', tradeoff: 'Useful if signals relate to general assistance' },
    ];
  }

  private fallbackAlternatives(skillName: string, skillInfo: SkillEntry | undefined) {
    const fm = skillInfo?.frontmatter ?? {};
    const triggersList = Array.isArray(fm['triggers']) ? fm['triggers'] : (fm['triggers'] ? [fm['triggers']] : [skillName]);
    const fmBlock = '---\nname: ' + (fm['name'] ?? skillName) + (fm['description'] ? '\ndescription: ' + JSON.stringify(fm['description']) : '') + (triggersList.length > 0 && fm['triggers'] ? '\ntriggers: ' + JSON.stringify(triggersList) : '') + '\n---\n\n';
    const body = skillInfo?.content ?? '';
    return [
      { id: 'A', label: 'Concise version', diff_or_content: fmBlock + '# ' + skillName + '\n\n' + body.slice(0, 500).trim() + '\n', tradeoff: 'Reduces noise, keeps the essentials' },
      { id: 'B', label: 'Original + examples', diff_or_content: fmBlock + body + '\n\n## Examples\n- Example 1\n- Example 2\n', tradeoff: 'More context, but longer' },
      { id: 'C', label: 'With explicit triggers (verbose)', diff_or_content: fmBlock + body, tradeoff: 'Frontmatter normalized; body unchanged' },
    ];
  }

  // ── Frontmatter validation + auto-fix ──

  private static readonly LEGACY_TUNER_FIELDS = ['trigger', 'triggers', 'risk_tier', 'auto_merge', 'auto_merge_default'];

  /**
   * Validate frontmatter for the 5 compliance rules.
   * Reads from the skill's path on disk.
   */
  validateFrontmatter(skill: SkillEntry): FrontmatterIssue[] {
    const issues: FrontmatterIssue[] = [];
    const fm = skill.frontmatter;
    const skillName = (fm['name'] as string | undefined) ?? basename(dirname(skill.path));
    const dirName = skill.format === 'directory'
      ? basename(dirname(skill.path))
      : basename(skill.path, '.md');

    // Rule 1: name field present
    if (!fm['name']) {
      issues.push({
        skill: dirName,
        path: skill.path,
        rule: 'missing-name',
        severity: 'error',
        autofixable: true,
        details: `name field missing; will use dirname "${dirName}"`,
      });
    }

    // Rule 2: name matches dirname (only for directory format)
    if (skill.format === 'directory' && fm['name'] && fm['name'] !== dirName) {
      issues.push({
        skill: dirName,
        path: skill.path,
        rule: 'name-mismatch',
        severity: 'error',
        autofixable: true,
        details: `name "${fm['name']}" does not match dirname "${dirName}"`,
      });
    }

    // Rule 3: description field present
    if (!fm['description']) {
      issues.push({
        skill: skillName,
        path: skill.path,
        rule: 'missing-description',
        severity: 'error',
        autofixable: true,
        details: 'description field missing',
      });
    }

    // Rule 4: description length >= 30 chars
    if (fm['description'] && typeof fm['description'] === 'string' && fm['description'].length < 30) {
      issues.push({
        skill: skillName,
        path: skill.path,
        rule: 'description-too-short',
        severity: 'warning',
        autofixable: false,
        details: `description is ${fm['description'].length} chars (minimum 30)`,
      });
    }

    // Rule 5: no legacy tuner fields in frontmatter
    for (const field of SkillsSubject.LEGACY_TUNER_FIELDS) {
      if (field in fm) {
        issues.push({
          skill: skillName,
          path: skill.path,
          rule: 'legacy-tuner-field',
          severity: 'error',
          autofixable: true,
          details: `legacy field "${field}" should be moved to config overrides`,
        });
      }
    }

    return issues;
  }

  /**
   * Apply safe (autofixable) fixes to a skill's frontmatter.
   * Creates a .pre-autofix-<ts>.bak backup before any write.
   * Returns fixed issues and remaining (non-autofixable) issues.
   */
  async autoFixFrontmatter(
    skill: SkillEntry,
    issues: FrontmatterIssue[],
  ): Promise<{ fixed: FrontmatterIssue[]; remaining: FrontmatterIssue[] }> {
    const fixable = issues.filter(i => i.autofixable);
    const remaining = issues.filter(i => !i.autofixable);

    if (fixable.length === 0) return { fixed: [], remaining };

    // Path containment guard
    const expandHome = (p: string) => p.replace(/^~/, homedir());
    const allowed = this.scanDirs.map(d => resolve(expandHome(d)));
    const targetReal = resolve(skill.path);
    if (!allowed.some(d => targetReal === d || targetReal.startsWith(d + sep) || targetReal.startsWith(d + '/'))) {
      throw new Error('autoFixFrontmatter: target ' + targetReal + ' outside scan_dirs');
    }

    // Read current content
    const currentContent = await readFile(skill.path, 'utf8');

    // Create backup
    const ts = Date.now();
    const backupPath = skill.path + '.pre-autofix-' + ts + '.bak';
    await copyFile(skill.path, backupPath);

    // Parse frontmatter
    const match = currentContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    const yaml = await import('js-yaml');
    let fm: Record<string, unknown> = {};
    let body = currentContent;
    if (match) {
      try { fm = (yaml.load(match[1]!) as Record<string, unknown>) ?? {}; } catch { fm = {}; }
      body = match[2]!;
    }

    const dirName = skill.format === 'directory'
      ? basename(dirname(skill.path))
      : basename(skill.path, '.md');

    const movedToConfig: Record<string, unknown> = {};
    const fixed: FrontmatterIssue[] = [];

    for (const issue of fixable) {
      if (issue.rule === 'missing-name') {
        fm['name'] = dirName;
        fixed.push(issue);
        auditLog('frontmatter_autofixed', { skill: issue.skill, path: issue.path, rule: issue.rule, value: dirName });
      } else if (issue.rule === 'name-mismatch') {
        fm['name'] = dirName;
        fixed.push(issue);
        auditLog('frontmatter_autofixed', { skill: issue.skill, path: issue.path, rule: issue.rule, value: dirName });
      } else if (issue.rule === 'missing-description') {
        // Extract from first heading + first paragraph of body
        const generated = this.extractDescriptionFromBody(body);
        if (generated) {
          fm['description'] = generated;
          fixed.push(issue);
          auditLog('frontmatter_autofixed', { skill: issue.skill, path: issue.path, rule: issue.rule, value: generated });
        } else {
          // Cannot extract — leave in remaining for proposal
          remaining.push(issue);
        }
      } else if (issue.rule === 'legacy-tuner-field') {
        // Collect all legacy fields from this skill for config
        for (const field of SkillsSubject.LEGACY_TUNER_FIELDS) {
          if (field in fm) {
            movedToConfig[field] = fm[field];
            delete fm[field];
          }
        }
        // Push all legacy field issues as fixed (they all get handled in one pass)
        for (const legacyIssue of fixable.filter(i => i.rule === 'legacy-tuner-field')) {
          if (!fixed.includes(legacyIssue)) {
            fixed.push(legacyIssue);
            auditLog('frontmatter_autofixed', { skill: legacyIssue.skill, path: legacyIssue.path, rule: 'legacy-tuner-field', field: legacyIssue.details });
          }
        }
        // Write moved fields to config overrides atomically
        if (Object.keys(movedToConfig).length > 0) {
          await this.writeLegacyFieldsToConfig(dirName, movedToConfig);
        }
      }
    }

    // Re-serialize frontmatter
    const fmLines = Object.entries(fm).map(([k, v]) => {
      if (typeof v === 'string' && !v.includes('\n') && !v.includes(':') && !v.includes('"')) {
        return k + ': ' + v;
      }
      return k + ': ' + JSON.stringify(v);
    });
    const newContent = '---\n' + fmLines.join('\n') + '\n---\n\n' + body;
    await writeFile(skill.path, newContent, 'utf8');

    return { fixed, remaining };
  }

  /**
   * Extract a description from the skill body using the first heading + first paragraph.
   */
  private extractDescriptionFromBody(body: string): string | null {
    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
    const headingLine = lines.find(l => l.startsWith('#'));
    const heading = headingLine ? headingLine.replace(/^#+\s*/, '').trim() : null;

    // Find first non-heading paragraph
    let paragraph: string | null = null;
    let inSkipZone = false;
    for (const line of lines) {
      if (line.startsWith('#')) { inSkipZone = false; continue; }
      if (!inSkipZone && line.length > 20) { paragraph = line; break; }
    }

    if (heading && paragraph) {
      return (heading + '. ' + paragraph).slice(0, 250);
    }
    if (heading && heading.length >= 10) {
      return heading.slice(0, 250);
    }
    if (paragraph && paragraph.length >= 10) {
      return paragraph.slice(0, 250);
    }
    return null;
  }

  /**
   * Write legacy fields from frontmatter to config overrides atomically.
   * Uses the in-memory overrides if no config file exists (test-friendly).
   */
  private async writeLegacyFieldsToConfig(skillName: string, fields: Record<string, unknown>): Promise<void> {
    // Validate skillName
    if (/[/\\]/.test(skillName) || skillName === '..' || skillName === '.') return;

    const configPath = join(homedir(), '.config', 'tuner', 'config.yaml');
    try {
      const yaml = await import('js-yaml');
      let config: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        const raw = await readFile(configPath, 'utf8');
        config = (yaml.load(raw) as Record<string, unknown>) ?? {};
      }

      // Ensure subjects.skills.overrides.<skillName> exists
      if (!config['subjects']) config['subjects'] = {};
      const subjects = config['subjects'] as Record<string, unknown>;
      if (!subjects['skills']) subjects['skills'] = {};
      const skillsCfg = subjects['skills'] as Record<string, unknown>;
      if (!skillsCfg['overrides']) skillsCfg['overrides'] = {};
      const overrides = skillsCfg['overrides'] as Record<string, unknown>;
      if (!overrides[skillName]) overrides[skillName] = {};
      const skillOverride = overrides[skillName] as Record<string, unknown>;

      // Map frontmatter field names to config field names
      const fieldMap: Record<string, string> = {
        'triggers': 'triggers',
        'trigger': 'triggers',
        'risk_tier': 'risk_tier',
        'auto_merge': 'auto_merge_default',
        'auto_merge_default': 'auto_merge_default',
      };
      for (const [k, v] of Object.entries(fields)) {
        const mapped = fieldMap[k] ?? k;
        skillOverride[mapped] = v;
      }

      // Atomic write: write to temp then rename
      const { mkdirSync } = await import('node:fs');
      const { rename } = await import('node:fs/promises');
      mkdirSync(dirname(configPath), { recursive: true });
      const tmpPath = configPath + '.tmp-' + Date.now();
      await writeFile(tmpPath, yaml.dump(config), 'utf8');
      await rename(tmpPath, configPath);
    } catch {
      // Config write is best-effort — don't fail the autofix
    }
  }

  /**
   * Walk all skills, validate frontmatter, auto-fix safe violations,
   * and return a compliance summary.
   */
  async runFrontmatterMaintenance(): Promise<FrontmatterMaintenanceReport> {
    const skills = await this.loadSkillsMap();
    let autoFixed = 0;
    const allViolations: FrontmatterIssue[] = [];

    for (const skill of skills.values()) {
      const issues = this.validateFrontmatter(skill);
      if (issues.length === 0) continue;

      const { fixed, remaining } = await this.autoFixFrontmatter(skill, issues);
      autoFixed += fixed.length;
      allViolations.push(...remaining);
    }

    // Invalidate cache since files may have changed
    if (autoFixed > 0) this.skillsCache = null;

    const report: FrontmatterMaintenanceReport = {
      total: skills.size,
      autoFixed,
      violations: allViolations,
    };

    auditLog('frontmatter_compliance_summary', {
      total: report.total,
      auto_fixed: autoFixed,
      violations: allViolations.length,
    });

    return report;
  }

  // ── Migration helpers ──

  /** List skills that are still in legacy flat format — migration candidates. */
  async listMigrationCandidates(): Promise<string[]> {
    const skills = await this.loadSkillsMap();
    return [...skills.values()]
      .filter(s => s.format === 'flat')
      .map(s => (s.frontmatter['name'] as string | undefined) ?? basename(s.path, '.md'));
  }

  /**
   * Convert a flat skill file to Anthropic directory format (<name>/SKILL.md).
   * Strips tuner-specific fields (triggers, risk_tier, auto_merge*) from frontmatter.
   * Returns the stripped fields so the caller can persist them to config.yaml.
   * Backs up the original flat file with a .pre-migration-<ts>.bak suffix before removing it.
   */
  async migrateSkillToDirectory(skillName: string): Promise<Record<string, unknown>> {
    // Validate skillName before any FS operations
    if (/[/\\]/.test(skillName) || skillName === '..' || skillName === '.') {
      throw new Error('Invalid skill name for migration: ' + skillName);
    }

    const skills = await this.loadSkillsMap();
    const skill = skills.get(skillName);
    if (!skill) throw new Error('Skill ' + skillName + ' not found');
    if (skill.format === 'directory') return {};  // already migrated

    const flatPath = skill.path;
    const baseDir = dirname(flatPath);
    const newDir = join(baseDir, skillName);
    const newPath = join(newDir, 'SKILL.md');

    // Path containment: newDir must be inside an allowed scanDir
    const allowed = this.scanDirs.map(d => resolve(d.replace(/^~/, homedir())));
    const newDirReal = resolve(newDir);
    if (!allowed.some(d => newDirReal === d || newDirReal.startsWith(d + sep) || newDirReal.startsWith(d + '/'))) {
      throw new Error('Migration target ' + newDirReal + ' outside scan_dirs');
    }

    if (existsSync(newDir)) {
      throw new Error('Cannot migrate: ' + newDir + ' already exists');
    }

    const TUNER_FIELDS = ['triggers', 'trigger', 'risk_tier', 'auto_merge', 'auto_merge_default'];
    const cleanedFrontmatter: Record<string, unknown> = {};
    const movedToConfig: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(skill.frontmatter)) {
      if (TUNER_FIELDS.includes(k)) {
        movedToConfig[k] = v;
      } else {
        cleanedFrontmatter[k] = v;
      }
    }

    // Serialize cleaned frontmatter to YAML (simple key: value, arrays as JSON for safety)
    const fmLines = Object.entries(cleanedFrontmatter).map(([k, v]) => {
      if (typeof v === 'string' && !v.includes('\n') && !v.includes(':') && !v.includes('"')) {
        return k + ': ' + v;
      }
      return k + ': ' + JSON.stringify(v);
    });
    const newContent = '---\n' + fmLines.join('\n') + '\n---\n\n' + skill.content;

    // Write backup BEFORE making any changes (if write fails later, original is intact)
    const backupPath = flatPath + '.pre-migration-' + Date.now() + '.bak';
    await copyFile(flatPath, backupPath);

    // Create directory and write SKILL.md
    await mkdir(newDir, { recursive: true });
    await writeFile(newPath, newContent, 'utf8');

    // Remove original flat file — backup already safe
    const { unlink } = await import('node:fs/promises');
    await unlink(flatPath);

    this.skillsCache = null;

    // Post-write frontmatter validation + auto-fix on migrated skill
    await this.postWriteFrontmatterFix(newPath);

    return movedToConfig;
  }

  currentStateHash(): string {
    const items: string[] = [];
    for (const dir of this.scanDirs) {
      const expanded = dir.replace(/^~/, homedir());
      if (!existsSync(expanded)) continue;
      const entries = walkSkillFiles(expanded);
      for (const e of entries) {
        items.push(`${e.relPath}\t${e.mtimeMs}\t${e.size}`);
      }
    }
    items.sort();
    return createHash('sha256').update(items.join('\n')).digest('hex');
  }
}

function walkSkillFiles(dir: string): Array<{ relPath: string; mtimeMs: number; size: number }> {
  const result: Array<{ relPath: string; mtimeMs: number; size: number }> = [];
  function recurse(current: string, prefix: string) {
    let names: string[];
    try { names = readdirSync(current); } catch { return; }
    for (const name of names) {
      if (typeof name !== 'string') continue;
      const full = join(current, name);
      const rel = prefix ? join(prefix, name) : name;
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch { continue; }
      if (isDir) {
        recurse(full, rel);
      } else if (name.endsWith('.md') && !name.includes('.bak')) {
        try {
          const st = statSync(full);
          result.push({ relPath: rel, mtimeMs: st.mtimeMs, size: st.size });
        } catch { /* skip unreadable */ }
      }
    }
  }
  recurse(dir, '');
  return result;
}
