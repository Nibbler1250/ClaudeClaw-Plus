import { computeProposalSignature, verifyProposalSignature, loadSecret, auditLog } from './security.js';
import { subjectConfig } from './config.js';
import type { TunerConfig } from './config.js';
import type { Proposal, UnsignedProposal } from './types.js';
import type { TunableSubject } from './interfaces.js';
import type { Registry } from './registry.js';
import type { ProposalsStore } from '../storage/proposals.js';
import type { RefusedStore } from '../storage/refused.js';
import type { BranchManager } from '../git_ops/branches.js';

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

export class Engine {
  private secret: Buffer;

  constructor(
    public readonly config: TunerConfig,
    public readonly registry: Registry,
    public readonly proposals: ProposalsStore,
    public readonly refused: RefusedStore,
    public readonly branches: BranchManager,
  ) {
    this.secret = loadSecret();
  }

  async runCycle(opts: { since?: Date; subjectName?: string; dryRun?: boolean } = {}): Promise<{ proposed: number; autoApplied: number }> {
    const windowDays = (this.config.detection as unknown as Record<string, unknown>)['window_days'] as number | undefined ?? 7;
    const since = opts.since ?? new Date(Date.now() - windowDays * 86_400_000);
    const totals = { proposed: 0, autoApplied: 0 };

    const subjects: TunableSubject[] = opts.subjectName
      ? [this.registry.getSubject(opts.subjectName)].filter((s): s is TunableSubject => s != null)
      : this.registry.enabledSubjects(this.config);

    for (const subject of subjects) {
      try {
        const r = await this._runSubject(subject.name, since, opts.dryRun ?? false);
        totals.proposed += r.proposed;
        totals.autoApplied += r.autoApplied;
      } catch (err) {
        console.error(`Error running subject ${subject.name}:`, err);
      }
    }
    return totals;
  }

  private async _runSubject(subjectName: string, since: Date, dryRun: boolean): Promise<{ proposed: number; autoApplied: number }> {
    const subject = this.registry.getSubject(subjectName);
    if (!subject) return { proposed: 0, autoApplied: 0 };

    const maxPerRun = this.config.detection.max_proposals_per_run;
    const refusedSigs = this.refused.activeSignatures();
    const appliedSigs = this.proposals.appliedSignatures({ withinDays: 30 });
    const pendingSigs = this.proposals.pendingSignatures({ subject: subjectName });

    const observations = await subject.collectObservations(since);
    const clusters = await subject.detectProblems(observations);

    let proposed = 0;
    let autoApplied = 0;

    for (const cluster of clusters) {
      if (proposed >= maxPerRun) break;

      const rawProposal: UnsignedProposal = await subject.proposeChange(cluster);

      // Dedup checks (anti-spam — bug fix 2351440)
      if (refusedSigs.has(rawProposal.pattern_signature)) continue;
      if (appliedSigs.has(rawProposal.pattern_signature)) continue;
      if (pendingSigs.has(rawProposal.pattern_signature)) continue;

      if (dryRun) { proposed++; continue; }

      // Assign ID and sign
      const existingRecords = this.proposals.readAll();
      // Use reduce instead of Math.max(...spread) to avoid stack overflow at ~10k+ records
      const nextId = existingRecords.reduce((max, r) => Math.max(max, r?.proposal?.id ?? 0), 0) + 1;
      const unsignedProposal: UnsignedProposal = { ...rawProposal, id: nextId };
      const sig = computeProposalSignature(unsignedProposal, this.secret);
      const signedProposal: Proposal = { ...unsignedProposal, signature: sig };

      this.proposals.append({ proposal: signedProposal, event: 'created', ts: new Date().toISOString() });
      auditLog('proposal_created', { proposal_id: signedProposal.id, subject: signedProposal.subject, pattern_signature: signedProposal.pattern_signature });
      proposed++;

      // Auto-merge check — high/critical risk_tier subjects never auto-merge
      const subjectCfg = subjectConfig(this.config, subjectName);
      const autoMerge = subjectCfg.auto_merge;
      const shouldAutoMerge = autoMerge === true || (Array.isArray(autoMerge) && autoMerge.includes(signedProposal.kind));
      if (subject.risk_tier === 'high' || subject.risk_tier === 'critical') {
        if (shouldAutoMerge) {
          console.warn(`[Engine] Auto-merge blocked: subject ${subjectName} has risk_tier=${subject.risk_tier}`);
          auditLog('auto_merge_blocked', { proposal_id: signedProposal.id, subject: subjectName, risk_tier: subject.risk_tier });
        }
      } else if (shouldAutoMerge && signedProposal.alternatives.length > 0) {
        try {
          await this.applyProposal(signedProposal.id, signedProposal.alternatives[0]!.id);
          autoApplied++;
        } catch (err) {
          console.error(`Auto-merge failed for proposal ${signedProposal.id}:`, err);
        }
      }
    }
    return { proposed, autoApplied };
  }

  async applyProposal(proposalId: number, alternativeId: string): Promise<void> {
    const record = this.proposals.readAll().find(r => r?.proposal?.id === proposalId && r.event === 'created');
    if (!record) throw new Error(`Proposal #${proposalId} not found or not pending`);
    const proposal = record.proposal;

    const subject = this.registry.getSubject(proposal.subject);
    if (!subject) throw new Error(`Subject ${proposal.subject} not registered`);

    auditLog('apply_attempted', { proposal_id: proposalId, alternative_id: alternativeId });

    if (!verifyProposalSignature(proposal, this.secret)) {
      auditLog('signature_mismatch', { proposal_id: proposalId });
      throw new SecurityError(`Proposal #${proposalId} signature mismatch — tamper detected`);
    }

    const patch = await subject.apply(proposal, alternativeId);
    const validation = await subject.validate(patch);

    if (!validation.valid) {
      auditLog('apply_invalid', { proposal_id: proposalId, reason: validation.reason });
      throw new Error(`Validation failed: ${validation.reason ?? 'unknown'}`);
    }

    await this.branches.createProposalBranch(proposalId);
    const commitSha = await this.branches.commitPatch(patch, proposal, alternativeId);

    this.proposals.append({
      proposal,
      event: 'applied',
      ts: new Date().toISOString(),
      alternative_id: alternativeId,
      commit_sha: commitSha,
    });
    auditLog('apply_success', { proposal_id: proposalId, alternative_id: alternativeId, commit_sha: commitSha });
  }

  async refuseProposal(proposalId: number, reason = 'refuse'): Promise<void> {
    const record = this.proposals.readAll().find(r => r?.proposal?.id === proposalId);
    if (!record) throw new Error(`Proposal #${proposalId} not found`);
    const proposal = record.proposal;

    this.refused.add(proposal.pattern_signature, proposal.subject, reason);
    this.proposals.append({ proposal, event: 'refused', ts: new Date().toISOString() });
    auditLog('refused', { proposal_id: proposalId, pattern_signature: proposal.pattern_signature });
  }

  async revertProposal(proposalId: number): Promise<void> {
    const appliedRecord = this.proposals.readAll().find(r => r?.proposal?.id === proposalId && r.event === 'applied');
    if (!appliedRecord) throw new Error(`No applied record found for proposal #${proposalId}`);

    const commitSha = (appliedRecord as typeof appliedRecord & { commit_sha?: string }).commit_sha;
    if (!commitSha) throw new Error(`No commit SHA recorded for proposal #${proposalId}`);

    try {
      // Checkout the proposal branch so revert applies in the right context
      await this.branches.checkoutProposalBranch(proposalId);
      await this.branches.revertPatch(commitSha);
      auditLog('reverted', { proposal_id: proposalId, commit_sha: commitSha });
    } catch (err) {
      auditLog('revert_failed', { proposal_id: proposalId, commit_sha: commitSha, error: String(err) });
      throw err;
    }
  }
}
