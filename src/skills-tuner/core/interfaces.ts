import type { Cluster, Observation, Patch, Proposal, UnsignedProposal, ValidationResult } from './types.js';
import { ORPHAN_SUBJECT } from './types.js';

export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

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
}

export abstract class Adapter {
  abstract renderProposal(proposal: Proposal): Promise<void>;
  abstract renderApplyConfirmation(proposal: Proposal, alternativeId: string): Promise<void>;
}

export { ORPHAN_SUBJECT, CREATE_KINDS } from './types.js';
export type { UnsignedProposal } from './types.js';
