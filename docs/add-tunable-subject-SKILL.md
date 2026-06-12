---
name: add-tunable-subject
description: >-
  Complete, do-not-forget playbook for adding a NEW tunable subject to the tuner
  (ClaudeClaw-Plus / wisecron) AND wiring its OutcomeLoop fitness measurement end
  to end — subject class, telemetry source (incl. requesting a new host stream via
  PR), registration, OutcomeLoop integration, tests, and live verification. Use
  whenever creating or fully wiring a TunableSubject so nothing is missed and it
  ships functional. Reference template: ClaudeMdSubject (the one fully-wired subject).
---

# Add a tunable subject (end to end)

Goal: a subject that (1) detects + proposes changes, and (2) has a **measured fitness
outcome** (baseline → apply → maturation → verdict), so the tuner can tell whether a
change actually helped — auditable, no-regression, degrades gracefully.

Work on a branch off the wisecron line (`feat/wisecron-intelligent-cron`), local-only
until greenlit. Reference real code; the canonical contract doc is
`~/simon-memory/decisions/tuner-outcome-loop.md`.

---

## 0. Decide the shape first (5 min, saves rework)

- **What does it tune?** The managed artifact/config (file, cron, hook, prompt, memory…).
- **risk_tier**: `low | medium | high | critical`. Drives auto-merge + revert routing.
  low → can auto-apply + auto-revert; medium/high/critical → human-gated; critical never
  auto-merges.
- **Fitness source tier** (the key decision):
  - **Tier 1b — artifact** (`source: "artifact"`): a static scan of the managed file
    (broken imports, dup count, unaudited allowlist). **Always available, no host
    dependency.** Prefer this — every subject should have at least one so it's never dead.
  - **Tier 1 — stream** (`source: <TelemetryStream>`): a runtime signal the HOST emits
    (cost, error-rate, latency, dispatch). Needs a producer (see §2).
  - **Tier 2 — judge**: non-deterministic LLM judgement. DEFERRED in Phase 1 — do not ship.

---

## 1. The subject class — `src/tuner/subjects/<name>-subject.ts`

`export class XSubject extends BaseSubject` (which `extends TunableSubject`,
`src/skills-tuner/core/interfaces.ts`).

### Required (abstract — must implement)
- `readonly name: string`
- `collectObservations(since: Date): Promise<Observation[]>` — read the info source, emit
  qualitative signals (`signal_type: correction|positive_feedback|repeated_trigger|orphan`).
  Return `[]` (not throw) when the source is missing.
- `detectProblems(observations): Promise<Cluster[]>` — group into clusters (frequency,
  success_rate, sentiment).
- `proposeChange(cluster): Promise<UnsignedProposal>` — 1–3 `alternatives` (id, label,
  diff_or_content, tradeoff) + `pattern_signature` (dedup key). Usually uses `this.llm`.
- `apply(proposal, alternativeId): Promise<Patch>` — apply the chosen alternative, return
  `{ target_path, kind, applied_content }`.
- `validate(patch): Promise<ValidationResult>` — `{ valid, reason? }`. Guard path traversal
  (keep target inside `projectRoots`).

### Strongly recommended
- `risk_tier`, `supports_creation`, `orphan_min_observations`, `auto_merge_default`.
- `snapshotInverse?(target): Promise<string>` — capture the inverse-patch content BEFORE
  apply (prior file bytes / serialized prior JobSpec). Without it the pipeline falls back to
  reading `target` from disk.
- `healthProbe?(target): Promise<{failed, errors[]}>` — consulted by the apply observation
  window. **Required in practice for medium/high risk** — without it the auto-revert path is
  fail-open (effectively disabled). `registerWithProbeCheck` logs a boot warning if missing.
- `healthCheck?()` — producer-presence probe (`producer_found`, `sample_event_match_rate`,
  `reason`); folds into the capability surface.
- `currentStateHash()` — deterministic hash of managed state (drift detection between ticks).
- `scoreSignal()/reclassifySignal()` — only if the subject participates in cross-subject
  signal attribution.

### OutcomeLoop (the fitness half — the part most often forgotten)
- `fitnessSignals(): Metric[]` — declare metrics:
  `{ name, source: TelemetryStream | "artifact", kind: "verifiable", direction:
  "lower_is_better"|"higher_is_better", windowDays, guardrails?: string[] }`.
  - **No single-number maximisation** — always pair a target with `guardrails` (anti-Goodhart).
    e.g. cost↓ guarded by `critical_fire_success`; trigger_hit_rate↑ guarded by `task_success`.
- `measureFitness(range, provider): Promise<Record<string, number>>`:
  - Tier 1b: scan the managed artifact directly (ignore provider).
  - Tier 1: read ONLY via `provider.query(stream, range, filters)`. **Never hardcode paths/DBs.**
  - **Aggregate outlier-robustly** — median / trimmed mean / nonzero-rate, NEVER a raw sum
    (cost/latency are spiky). Use the helpers in `src/skills-tuner/core/fitness.ts` /
    aggregate utils.

---

## 2. The information source / telemetry

### Artifact (Tier 1b) — nothing to request
Read the file(s) in `measureFitness`. Done. Always-on.

### Stream (Tier 1) — and how to REQUEST a new one via PR
Streams live in `TELEMETRY_STREAMS` (`src/skills-tuner/core/telemetry.ts`). Current set:
`session_cost, tool_call, hook_exec, skill_access, cron_run, mode_dispatch,
template_feedback, memory_access, agent_dispatch`. **Only streams the HOST actually emits
are usable** (today: `session_cost` via governance/budget-guard; others are producer-pending).

If your subject needs a stream **not yet emitted**:
1. **Contract change (tuner side):** add the name to `TELEMETRY_STREAMS` and bump
   `TELEMETRY_CONTRACT_VERSION` in `telemetry.ts`.
2. **Producer (HOST side) — this is the PR:** the ClaudeClaw-Plus HOST owns telemetry
   production. Open a PR to the host that (a) emits the stream's `MetricSample`s, and
   (b) advertises it in the host's `TelemetryProvider.capabilities()` (the surface exposed
   to the tuner over the MCP bridge). Include: the source of truth, the sample schema
   (`ts/value/labels`), and the schema version.
3. **Until the producer lands:** the activation gate marks your metric
   `fitness_inactive(reason)` and the subject runs **proposal-only** — by design, not a bug.
   Keep a Tier 1b metric so the subject still measures something.

**Rule:** subjects NEVER touch raw sources — always `provider.query`. One auditable surface.

---

## 3. Register in the tuner — `src/tuner/wisecron/index.ts`

```ts
import { XSubject } from "../subjects/x-subject.js";
// inside buildWisecronContext, alongside the others:
if (enabled("x")) registerWithProbeCheck(new XSubject({ llm: opts.llm, ...cfg("x") }));
```
- `registerWithProbeCheck` = registry.registerSubject + scheduler.ensureRegistered +
  `warnIfMissingHealthProbe`.
- **Config:** add a `subjects.x` block to `~/.config/tuner/config.yaml`
  (`enabled`, `config: { scan_dirs / git_repo / … }`).
- **doctor:** ensure the subject's `git_repo`/`scan_dir` is on a standard path so
  `tuner doctor` validates it.

---

## 4. OutcomeLoop integration (mostly automatic — verify it fires)

Once `fitnessSignals()` + `measureFitness()` exist, the loop wires itself:
- **Activation gate** (`activateFitness`, `src/skills-tuner/core/fitness.ts`): at registration
  intersects your `fitnessSignals()` sources with `provider.capabilities()`. Boot log:
  `[tuner] subject 'x' fitness: active metric=… ` / `… inactive … reason=…`. Artifact metrics
  always active; judge never (Phase 1). NOTE: the gate only runs when the host wires a
  `TelemetryProvider` into `buildWisecronContext({ telemetry })` — absent one, proposal-only.
- **Baseline at apply:** apply-pipeline calls `snapshotBaseline(proposal)` → a row per active
  metric in `outcomes.jsonl`, keyed by proposal `id` + commit_sha.
- **Maturation:** `runMaturation()` (OutcomeRecorder, `src/tuner/wisecron/outcome-loop.ts`)
  computes post, delta, `decideVerdict` (no-regression incl. guardrails), and routes revert by
  risk_tier (low → auto `revertProposal`; medium+ → enqueue human-gated).
- **Audit:** every fitness_active/inactive, baseline, verdict, revert is appended to the
  tamper-evident `AuditLog` chain.

---

## 5. Tests (the assurance — nothing ships without these)

Mirror the existing patterns in `src/tuner/__tests__/wisecron/` and
`src/__tests__/skills-tuner/` (`outcome-loop`, `outcomes-ledger`, `outcome-verdict`,
`outcome-fitness-gate`, `outcome-aggregate`, `outcome-audit-log`, + per-subject tests).

**Subject pipeline:**
- [ ] `collectObservations` returns `[]` when source missing; parses real-ish input.
- [ ] `detectProblems` clusters correctly.
- [ ] `proposeChange` emits valid alternatives + stable `pattern_signature`.
- [ ] `apply` returns a correct `Patch`; `validate` rejects path-escape / malformed.
- [ ] `snapshotInverse` / `healthProbe` behave (revert works).
- [ ] `currentStateHash` stable + changes on real change.

**Fitness / OutcomeLoop:**
- [ ] `fitnessSignals()` returns the expected `Metric[]` (sources, directions, guardrails).
- [ ] `measureFitness` against a STUB provider (Tier 1) or fixture files (Tier 1b) returns
      expected numbers; **outlier-robustness** asserted (a huge outlier doesn't move median).
- [ ] activation gate: metric ACTIVE when stream advertised, INACTIVE-with-reason when not,
      artifact always active.
- [ ] baseline→maturation→verdict: improved / regressed / neutral; **guardrail regression
      overrides an improved target**; LOW-risk auto-reverts, HIGH-risk enqueues for human;
      does not mature before `window_end`.
- [ ] outcomes ledger: idempotent migration, baseline upsert, listMaturableOutcomes, priors.
- [ ] audit chain verifies + detects tampering.
- [ ] If a `platform`-dependent helper (e.g. path encoding): inject `platform` and test both.

**Gate:** `bun test` green (existing tests UNCHANGED + new ones), `bun run lint` (biome) clean
on changed files.

---

## 6. Live verification (real data, before declaring done)

1. `tuner doctor` → all green (config, storage, secret, subject paths).
2. `tuner cron-run --dry --since 30d` → runs clean; `tuner pending` shows real proposals.
3. **Real fitness read:** a tiny driver constructing the subject + calling `measureFitness`
   against real data (as we did for claude_md) → confirms a real number out of real input.
4. **Full loop (the "vrai"):** apply ONE low-risk proposal through the pipeline (writes
   baseline) → wait/force maturation → confirm `~/.config/tuner/outcomes.jsonl` gets a row
   with baseline, post, delta, verdict. Only then is the measurement path proven live.

---

## 7. Ship (SDC)

- `bun run bump:plugin-version` + `bun run bump:marketplace-version` (required CI guards).
- tests-passing + security review + code review (the SDC gates).
- PR from the fork → TerrysPOV; **no `Co-Authored-By`**; respect garde-tout-local until greenlit.

---

## Definition of done
A subject is DONE only when: pipeline methods + at least one Tier 1b fitness metric
implemented; (if Tier 1) the host stream exists or a producer PR is open; registered + config +
doctor green; all tests above pass + lint; and a **real** `measureFitness` run returns a number.
Detection alone (proposals) is NOT done — the OutcomeLoop measurement is the point.

---

## Appendix A — Subject skeleton (copy, then fill every TODO)

Copy to `src/tuner/subjects/<name>-subject.ts`. Adjust import paths to the tree. Reference
the fully-wired `ClaudeMdSubject` for real bodies. **Do not delete a method to "simplify" —
each missing piece silently removes a guarantee (revert, drift, fitness).**

```ts
import { existsSync, readFileSync } from "node:fs";
import { BaseSubject } from "../../skills-tuner/subjects/base.js";
import type {
  Cluster, Observation, Patch, Proposal, UnsignedProposal, ValidationResult,
} from "../../skills-tuner/core/types.js";
import type { DateRange, Metric, TelemetryProvider } from "../../skills-tuner/core/telemetry.js";
import { ARTIFACT_SOURCE } from "../../skills-tuner/core/telemetry.js";
import type { LLMClient } from "../../skills-tuner/core/llm.js"; // adjust

export interface XSubjectConfig {
  llm?: LLMClient;
  scanDirs?: string[]; // or whatever this subject manages
}

export class XSubject extends BaseSubject {
  readonly name = "x";
  readonly risk_tier = "low" as const;      // low|medium|high|critical — drives revert routing
  readonly supports_creation = false;
  readonly orphan_min_observations = 2;
  private readonly llm?: LLMClient;

  constructor(opts: XSubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    // TODO: resolve + store managed roots/paths (expandHome + resolve).
  }

  // ── detection pipeline ──────────────────────────────────────────────
  async collectObservations(_since: Date): Promise<Observation[]> {
    // TODO: read the info source; return [] (never throw) if it's missing.
    return [];
  }
  async detectProblems(_observations: Observation[]): Promise<Cluster[]> {
    // TODO: cluster observations (frequency, success_rate, sentiment).
    return [];
  }
  async proposeChange(_cluster: Cluster): Promise<UnsignedProposal> {
    // TODO: build 1–3 alternatives (+ stable pattern_signature). Often uses this.llm.
    throw new Error("TODO proposeChange");
  }
  async apply(_proposal: Proposal, _alternativeId: string): Promise<Patch> {
    // TODO: apply chosen alternative; return { target_path, kind, applied_content }.
    throw new Error("TODO apply");
  }
  async validate(_patch: Patch): Promise<ValidationResult> {
    // TODO: reject path-escape / malformed. Guard target stays inside managed roots.
    return { valid: true };
  }

  // ── revert / drift / health (don't drop these) ──────────────────────
  async snapshotInverse(_target: string): Promise<string> {
    // TODO: capture prior content BEFORE apply (file bytes / serialized prior spec).
    return "";
  }
  async healthProbe(_target: string): Promise<{ failed: boolean; errors: string[] }> {
    // REQUIRED for medium/high risk, else auto-revert is fail-open.
    return { failed: false, errors: [] };
  }
  currentStateHash(): string {
    // TODO: deterministic hash of managed state (no clocks/random). "" disables drift.
    return "";
  }

  // ── OutcomeLoop fitness (the half most often forgotten) ─────────────
  fitnessSignals(): Metric[] {
    return [
      // Always ship at least one artifact (Tier 1b) metric so the subject is never dead:
      { name: "x_defect_count", source: ARTIFACT_SOURCE, kind: "verifiable",
        direction: "lower_is_better", windowDays: 1 },
      // Tier 1 stream example (only activates if the host advertises the stream):
      // { name: "x_cost", source: "session_cost", kind: "verifiable",
      //   direction: "lower_is_better", windowDays: 7, guardrails: ["x_success_rate"] },
    ];
  }
  async measureFitness(range: DateRange, provider: TelemetryProvider): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    // Tier 1b — scan the managed artifact directly:
    out.x_defect_count = this.scanDefects(); // TODO
    // Tier 1 — read ONLY via provider (never hardcode paths); aggregate outlier-robustly:
    // const samples = await provider.query("session_cost", range, { /* labels */ });
    // out.x_cost = median(samples.map(s => s.value));   // median/trimmed-mean, NEVER raw sum
    void range; void provider;
    return out;
  }
  private scanDefects(): number { return 0; /* TODO */ }
}
```

After writing: add to `src/tuner/wisecron/index.ts` →
`if (enabled("x")) registerWithProbeCheck(new XSubject({ llm: opts.llm, ...cfg("x") }));`

---

## Appendix B — Host stream-producer PR template (when a subject needs a new Tier 1 stream)

The tuner only declares/consumes streams; the **HOST (ClaudeClaw-Plus) produces them**. To make
a new stream real, open a PR to the host with ALL of the below — otherwise the metric stays
`fitness_inactive` forever.

```markdown
## Add telemetry stream: `<stream_name>`

### Why
<which tunable subject needs it, and which fitness Metric consumes it>

### Producer
- Source of truth: <log / journal / db / event — where the data originates on the host>
- Emits `MetricSample { ts, value, labels }`:
  - `value`: <what the number is, and its unit>
  - `labels`: <dimensions the subject filters/groups on — e.g. model, unit, tool, agent_id>
- Sampling cadence / retention: <how often, how long kept>

### Contract wiring (host side)
- [ ] `TelemetryProvider.query("<stream_name>", range, filters)` returns the samples.
- [ ] `TelemetryProvider.capabilities()` advertises `{ stream:"<stream_name>",
      schemaVersion, available:true }` when emitting (false + `reason` when not).
- [ ] Stream name added to `TELEMETRY_STREAMS`; `TELEMETRY_CONTRACT_VERSION` bumped.
- [ ] Exposed over the MCP bridge (the surface the tuner consumes).

### Tests
- [ ] `query` returns expected samples over a window + label filter.
- [ ] `capabilities()` reports available/unavailable correctly (degrade-gracefully).
- [ ] Schema/version snapshot test (for certification).

### Audit / certification
- [ ] One provenance point documented (so a customer auditor can trace value → source).
```

Until this lands, keep the subject on its Tier 1b artifact metric — it still measures, the
stream metric just stays inactive (by design).
