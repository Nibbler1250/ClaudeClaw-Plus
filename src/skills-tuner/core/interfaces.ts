import type {
  Cluster,
  Observation,
  Patch,
  Proposal,
  UnsignedProposal,
  ValidationResult,
} from "./types.js";
import { ORPHAN_SUBJECT } from "./types.js";
import type { DateRange, Metric, TelemetryProvider } from "./telemetry.js";

export type RiskTier = "low" | "medium" | "high" | "critical";

export abstract class TunableSubject {
  abstract readonly name: string;
  readonly risk_tier: RiskTier = "low";
  readonly auto_merge_default: boolean = false;
  readonly supports_creation: boolean = false;
  readonly orphan_min_observations: number = 2;

  abstract collectObservations(since: Date): Promise<Observation[]>;
  abstract detectProblems(observations: Observation[]): Promise<Cluster[]>;
  abstract proposeChange(cluster: Cluster): Promise<UnsignedProposal>;
  abstract apply(proposal: Proposal, alternativeId: string): Promise<Patch>;
  abstract validate(patch: Patch): Promise<ValidationResult>;

  scoreSignal(
    _verbatim: string,
    _attributedTo: string,
    _knownEntities: Record<string, unknown>,
  ): number {
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
    return "";
  }

  /**
   * OutcomeLoop: declare the fitness metrics this subject can be scored on.
   * Default = none (opt-in, backward-compatible — mirrors how `scoreSignal`
   * was added as a non-abstract default). Each `Metric.source` is a
   * `TelemetryStream` name (Tier 1) or `"artifact"` (Tier 1b). At registration
   * the loop intersects these sources with the host's `TelemetryProvider`
   * capabilities and only activates fitness for available streams; the rest
   * stay proposal-only.
   */
  fitnessSignals(): Metric[] {
    return [];
  }

  /**
   * OutcomeLoop: measure the declared fitness metrics over `range`, reading
   * telemetry exclusively through the host-provided `provider` (Tier 1) or by
   * scanning the managed artifact (Tier 1b). Returns metric-name → value.
   *
   * Default = `{}` so every existing subject compiles unchanged. Overrides
   * MUST aggregate samples outlier-robustly (median / trimmed mean, never a
   * raw sum). Provider is passed in — subjects never touch raw sources.
   */
  async measureFitness(
    _range: DateRange,
    _provider: TelemetryProvider,
  ): Promise<Record<string, number>> {
    return {};
  }

  /**
   * Optional: produce the inverse-patch `applied_content` for `target`
   * before apply() runs. When undefined, the pipeline falls back to reading
   * `target` from disk. Overriders return a string (the inverse content) —
   * cron serializes the prior JobSpec, hook captures the prior file bytes.
   */
  snapshotInverse?(target: string): Promise<string>;

  /**
   * Optional: per-subject health probe consulted by the apply pipeline's
   * observation window. When undefined for a high/medium-risk subject, the
   * pipeline logs a boot warning and the auto-revert path is effectively
   * disabled (the default pipeline probe is fail-open).
   */
  healthProbe?(target: string): Promise<{ failed: boolean; errors: string[] }>;

  /**
   * Optional: report whether the subject's expected telemetry producer is
   * present and emitting data. Five wisecron subjects (cron, hook,
   * mcp-plugin, model-routing, prompt-template) silently return 0
   * observations when their log/journal source is missing — operators have
   * no signal that the subject is misconfigured vs. genuinely quiet.
   *
   * `producer_found`: whether the upstream source exists at all (e.g.
   * journal contains wisecron-* units, hooks dir has *.sh files,
   * operations.jsonl exists).
   * `sample_event_match_rate`: of recent events from the source, fraction
   * that the subject's filter would actually pick up. 0..1.
   * `reason`: human-readable diagnostic when producer_found is false.
   *
   * Called once at boot (registerWisecronSubjects) and logged. Optional —
   * subjects that scan static files (memory, agent, claude-md) can skip.
   *
   * FOLD (OutcomeLoop): producer-presence is now also expressed through the
   * host's `TelemetryProvider.capabilities()` — the single auditable surface.
   * `deriveCapabilitiesFromHealthChecks()` bridges these per-subject probes
   * into stream capabilities so the activation gate consults one place. This
   * method stays as the boot-time diagnostic; capabilities() is canonical for
   * fitness activation.
   */
  healthCheck?(): Promise<{
    producer_found: boolean;
    sample_event_match_rate: number;
    reason?: string;
  }>;
}

export abstract class Adapter {
  abstract renderProposal(proposal: Proposal): Promise<void>;
  abstract renderApplyConfirmation(proposal: Proposal, alternativeId: string): Promise<void>;
}

export { ORPHAN_SUBJECT, CREATE_KINDS } from "./types.js";
export type { UnsignedProposal } from "./types.js";
