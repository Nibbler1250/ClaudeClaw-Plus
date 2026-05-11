import { homedir } from 'node:os';
import { Engine } from '../core/engine.js';
import { Registry } from '../core/registry.js';
import { ProposalsStore, DEFAULT_PROPOSALS_PATH } from '../storage/proposals.js';
import { RefusedStore, DEFAULT_REFUSED_PATH } from '../storage/refused.js';
import { BranchManager } from '../git_ops/branches.js';
import { SkillsSubject, type SkillOverride } from '../subjects/skills.js';
import { WiseCronSubject } from '../subjects/wisecron.js';
import { ConversationSubject } from '../subjects/conversation.js';
import { makeLLMClient, type LLMClient } from '../core/llm.js';
import type { TunerConfig } from '../core/config.js';

export interface EngineBundle {
  engine: Engine;
  registry: Registry;
  proposals: ProposalsStore;
  refused: RefusedStore;
  branches: BranchManager;
}

/**
 * Build a fully wired Engine with native subjects registered from config.
 *
 * Without this, CLI commands instantiate an empty Registry and runCycle()
 * sees zero subjects — no proposals, no drift detection. Every CLI command
 * that needs an Engine MUST go through this function.
 */
export function bootstrapEngine(config: TunerConfig): EngineBundle {
  const registry = new Registry();
  const proposals = new ProposalsStore(config.storage.proposals_jsonl ?? DEFAULT_PROPOSALS_PATH);
  const refused = new RefusedStore(config.storage.refused_jsonl ?? DEFAULT_REFUSED_PATH);
  const gitRepo = config.storage.git_repo;
  if (!gitRepo) throw new Error('storage.git_repo must be set in config');
  const branches = new BranchManager(gitRepo);
  const engine = new Engine(config, registry, proposals, refused, branches);

  // Build the LLM client once and share across subjects. If construction fails
  // (no API key + no claude CLI fallback), log the reason and continue without
  // an LLM so the engine falls through to static fallback alternatives instead
  // of hard-failing the whole cycle.
  let llm: LLMClient | undefined;
  try {
    llm = makeLLMClient(config);
  } catch (err) {
    console.warn('[skills-tuner] LLM client unavailable, proposals will use static fallback:', (err as Error).message);
  }

  registerNativeSubjects(registry, config, llm);

  return { engine, registry, proposals, refused, branches };
}

function registerNativeSubjects(registry: Registry, config: TunerConfig, llm: LLMClient | undefined): void {
  const skillsCfg = config.subjects['skills'];
  if (skillsCfg && skillsCfg.enabled !== false) {
    const scanDirs = (skillsCfg.scan_dirs ?? []).map(d => d.replace(/^~/, homedir()));
    const overrides = (skillsCfg.overrides ?? {}) as Record<string, SkillOverride>;
    const language = config.proposer?.language_preference ?? 'en';
    registry.registerSubject(new SkillsSubject({ scanDirs, overrides, language, llm }));
  }

  // WiseCron: always registered (reads crontab directly, no config deps)
  const wisecronCfg = config.subjects['wisecron'];
  if (wisecronCfg?.enabled !== false) {
    registry.registerSubject(new WiseCronSubject());
  }

  // Conversation: analyze discussion patterns, Simon ↔ Greg
  const conversationCfg = config.subjects['conversation'];
  if (conversationCfg?.enabled !== false) {
    registry.registerSubject(new ConversationSubject());
  }
}
