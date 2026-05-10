import type { Cluster, Observation, Patch, Proposal, UnsignedProposal, ValidationResult } from './types.js';
import { ORPHAN_SUBJECT } from './types.js';

export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

export interface FrontmatterIssue {
  skill: string;
  path: string;
  rule: 'missing-name' | 'name-mismatch' | 'missing-description' | 'description-too-short' | 'legacy-tuner-field';
  severity: 'error' | 'warning';
  autofixable: boolean;
  details?: string;
}

export interface FrontmatterMaintenanceReport {
  total: number;
  autoFixed: number;
  violations: FrontmatterIssue[];
}

export abstract class TunableSubject {
  abstract readonly name: string;
  readonly risk_tier: RiskTier = 'low';
  readonly auto_merge_default: boolean = false;
  readonly supports_creation: boolean = false;
  readonly orphan_min_observations: number = 2;

  abstract collectObservations(since: Date): Promise<Observation[]>;
  abstract detectProblems(observations: Observation[]): Promise<Cluster[]>;
  abstract proposeChange(cluster: Cluster): Promise<UnsignedProposal>;
  abstract apply(proposal: Proposal, alternativeId: string): Promise<Patch>;
  abstract validate(patch: Patch): Promise<ValidationResult>;

  scoreSignal(_verbatim: string, _attributedTo: string, _knownEntities: Record<string, unknown>): number {
    return 0;
  }

  reclassifySignal(_verbatim: string, _knownEntities: Record<string, unknown>): string {
    return ORPHAN_SUBJECT;
  }

  /**
   * Compute a deterministic hash of this subject's managed state.
   * Used by the engine to detect drift between cron ticks.
   *
   * Default returns empty string (no drift detection — opt-in per subject).
   * Override to track changes in scan_dirs, plugin lists, RAG corpus, etc.
   *
   * Hash must be stable across runs (no clocks, no random) and reflect
   * any meaningful change to what the subject would propose tuning.
   */
  currentStateHash(): string {
    return '';
  }

  /**
   * Walk all managed skills, validate frontmatter, auto-fix safe violations,
   * and return a summary report. Subjects that manage skill files should
   * override this to participate in the per-cycle pre-pass.
   */
  runFrontmatterMaintenance?(): Promise<FrontmatterMaintenanceReport>;
}

export abstract class Adapter {
  abstract renderProposal(proposal: Proposal): Promise<void>;
  abstract renderApplyConfirmation(proposal: Proposal, alternativeId: string): Promise<void>;
}

export { ORPHAN_SUBJECT, CREATE_KINDS } from './types.js';
export type { UnsignedProposal } from './types.js';
