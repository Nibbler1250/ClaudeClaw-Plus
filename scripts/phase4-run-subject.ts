/**
 * Phase 4 harness — runs collectObservations → detectProblems → proposeChange
 * for any wisecron subject against real ProDesk state and dumps every phase to
 * /tmp/wisecron-phase4/<subject>-{observations,clusters,proposals}.json.
 *
 * READ-ONLY: no apply, no revert, no writes to anything except /tmp/.
 *
 * Usage:
 *   bun run scripts/phase4-run-subject.ts <subject> [overrides-json]
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Cluster, Observation, UnsignedProposal } from '../src/skills-tuner/core/types.js';

import { CronSubject } from '../src/tuner/subjects/cron-subject.js';
import { HookSubject } from '../src/tuner/subjects/hook-subject.js';
import { MemorySubject } from '../src/tuner/subjects/memory-subject.js';
import { AgentSubject } from '../src/tuner/subjects/agent-subject.js';
import { ClaudeMdSubject } from '../src/tuner/subjects/claude-md-subject.js';
import { McpPluginSubject } from '../src/tuner/subjects/mcp-plugin-subject.js';
import { ModelRoutingSubject } from '../src/tuner/subjects/model-routing-subject.js';
import { PromptTemplateSubject } from '../src/tuner/subjects/prompt-template-subject.js';

const OUT = '/tmp/wisecron-phase4';
mkdirSync(OUT, { recursive: true });

const SEVEN_DAYS_AGO = new Date(Date.now() - 7 * 24 * 3600 * 1000);

type AnySubject = {
  name: string;
  collectObservations(since: Date): Promise<Observation[]>;
  detectProblems(obs: Observation[]): Promise<Cluster[]>;
  proposeChange(c: Cluster): Promise<UnsignedProposal>;
};

interface SubjectRun {
  label: string;
  build: () => AnySubject;
}

// ── Real-data file readers (injected into subjects whose default reader is
// either spawn-based or returns [] without an injection). All read-only.

function readOperationsJsonl(path: string, since: Date): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const out: Array<Record<string, unknown>> = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t) as Record<string, unknown>;
      const tsRaw = ev['ts'] ?? ev['timestamp'] ?? ev['time'];
      if (tsRaw) {
        const d = new Date(tsRaw as string | number);
        if (!Number.isNaN(d.getTime()) && d < since) continue;
      }
      out.push(ev);
    } catch {
      /* skip non-JSON line */
    }
  }
  return out;
}

function readHookLogs(dir: string, since: Date): Array<{
  hook: string;
  exitCode: number;
  durationMs: number;
  eventType: string;
  timestamp: Date;
}> {
  if (!existsSync(dir)) return [];
  const out: Array<{
    hook: string;
    exitCode: number;
    durationMs: number;
    eventType: string;
    timestamp: Date;
  }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.log')) continue;
    const p = join(dir, name);
    let raw: string;
    try { raw = readFileSync(p, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(t); } catch { continue; }
      const tsRaw = entry['timestamp'] ?? entry['ts'];
      const ts = tsRaw ? new Date(tsRaw as string | number) : new Date();
      if (ts < since) continue;
      out.push({
        hook: String(entry['hook'] ?? name.replace(/\.log$/, '')),
        exitCode: Number(entry['exit_code'] ?? entry['exitCode'] ?? 0),
        durationMs: Number(entry['duration_ms'] ?? entry['durationMs'] ?? 0),
        eventType: String(entry['event'] ?? entry['eventType'] ?? 'unknown'),
        timestamp: ts,
      });
    }
  }
  return out;
}

// ── Per-subject build configurations.

const SUBJECTS: Record<string, SubjectRun[]> = {
  cron: [
    { label: 'cron-default', build: () => new CronSubject() },
  ],
  hook: [
    { label: 'hook-claude', build: () => new HookSubject({
      hooksDir: join(homedir(), '.claude', 'hooks'),
      logReader: readHookLogs,
    }) },
    { label: 'hook-agent', build: () => new HookSubject({
      hooksDir: join(homedir(), 'agent', 'hooks'),
      logReader: readHookLogs,
    }) },
  ],
  memory: [
    { label: 'memory-home-simon', build: () => new MemorySubject({
      memoryIndex: join(homedir(), '.claude/projects/-home-simon/memory/MEMORY.md'),
    }) },
    { label: 'memory-home-simon-agent', build: () => new MemorySubject({
      memoryIndex: join(homedir(), '.claude/projects/-home-simon-agent/memory/MEMORY.md'),
    }) },
    { label: 'memory-home-simon-agent-claudeclaw', build: () => new MemorySubject({
      memoryIndex: join(homedir(), '.claude/projects/-home-simon-agent-claudeclaw/memory/MEMORY.md'),
    }) },
  ],
  agent: [
    { label: 'agent-agent-agents-dir', build: () => new AgentSubject({
      agentsDir: join(homedir(), 'agent', 'agents'),
    }) },
  ],
  'claude-md': [
    { label: 'claude-md-default', build: () => new ClaudeMdSubject({
      projectRoots: ['~/agent', '~/Projects', '~/simon-memory'],
    }) },
  ],
  'mcp-plugin': [
    { label: 'mcp-plugin-operations-jsonl', build: () => new McpPluginSubject({
      auditLog: join(homedir(), '.claudeclaw/journal/operations.jsonl'),
      auditReader: readOperationsJsonl,
    }) },
  ],
  'model-routing': [
    { label: 'model-routing-operations-jsonl', build: () => new ModelRoutingSubject({
      dispatchReader: (since: Date) => readOperationsJsonl(
        join(homedir(), '.claudeclaw/journal/operations.jsonl'),
        since,
      ),
    }) },
  ],
  'prompt-template': [
    { label: 'prompt-template-default', build: () => new PromptTemplateSubject({
      feedbackLog: join(homedir(), '.claude/template_feedback.jsonl'),
    }) },
  ],
};

async function run(subjectKey: string): Promise<void> {
  const variants = SUBJECTS[subjectKey];
  if (!variants) {
    console.error(`unknown subject: ${subjectKey} (valid: ${Object.keys(SUBJECTS).join(', ')})`);
    process.exit(2);
  }

  const allObs: Array<{ variant: string; observations: Observation[] }> = [];
  const allClusters: Array<{ variant: string; clusters: Cluster[] }> = [];
  const allProposals: Array<{ variant: string; proposals: UnsignedProposal[] }> = [];
  const timing: Array<{ variant: string; collect_ms: number; detect_ms: number; propose_ms: number; obs: number; clusters: number; proposals: number }> = [];

  for (const v of variants) {
    let inst: AnySubject;
    try {
      inst = v.build();
    } catch (e) {
      console.error(`[${v.label}] build failed: ${(e as Error).message}`);
      allObs.push({ variant: v.label, observations: [] });
      allClusters.push({ variant: v.label, clusters: [] });
      allProposals.push({ variant: v.label, proposals: [] });
      timing.push({ variant: v.label, collect_ms: -1, detect_ms: -1, propose_ms: -1, obs: 0, clusters: 0, proposals: 0 });
      continue;
    }

    const t0 = performance.now();
    let observations: Observation[] = [];
    try {
      observations = await inst.collectObservations(SEVEN_DAYS_AGO);
    } catch (e) {
      console.error(`[${v.label}] collectObservations error: ${(e as Error).message}`);
    }
    const t1 = performance.now();

    let clusters: Cluster[] = [];
    try {
      clusters = await inst.detectProblems(observations);
    } catch (e) {
      console.error(`[${v.label}] detectProblems error: ${(e as Error).message}`);
    }
    const t2 = performance.now();

    const proposals: UnsignedProposal[] = [];
    for (const c of clusters) {
      try {
        proposals.push(await inst.proposeChange(c));
      } catch (e) {
        console.error(`[${v.label}] proposeChange cluster=${c.id} error: ${(e as Error).message}`);
      }
    }
    const t3 = performance.now();

    allObs.push({ variant: v.label, observations });
    allClusters.push({ variant: v.label, clusters });
    allProposals.push({ variant: v.label, proposals });
    timing.push({
      variant: v.label,
      collect_ms: Math.round(t1 - t0),
      detect_ms: Math.round(t2 - t1),
      propose_ms: Math.round(t3 - t2),
      obs: observations.length,
      clusters: clusters.length,
      proposals: proposals.length,
    });

    console.log(`[${v.label}] obs=${observations.length} clusters=${clusters.length} proposals=${proposals.length} timing(ms)=${t1 - t0 | 0}/${t2 - t1 | 0}/${t3 - t2 | 0}`);
  }

  writeFileSync(`${OUT}/${subjectKey}-observations.json`, JSON.stringify(allObs, null, 2));
  writeFileSync(`${OUT}/${subjectKey}-clusters.json`, JSON.stringify(allClusters, null, 2));
  writeFileSync(`${OUT}/${subjectKey}-proposals.json`, JSON.stringify(allProposals, null, 2));
  writeFileSync(`${OUT}/${subjectKey}-timing.json`, JSON.stringify(timing, null, 2));

  console.log(`\nWrote ${OUT}/${subjectKey}-{observations,clusters,proposals,timing}.json`);
}

const subjectKey = process.argv[2];
if (!subjectKey) {
  console.error(`usage: bun run scripts/phase4-run-subject.ts <subject>`);
  console.error(`subjects: ${Object.keys(SUBJECTS).join(', ')}`);
  process.exit(2);
}

await run(subjectKey);
