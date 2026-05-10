# skills-tuner

Continuous-improvement platform for any tunable system surface (Claude Code skills, voice intent lexicons, RAG corpora, MCP plugin configs, ML hyperparameters). Detects user friction, proposes alternatives via LLM, surfaces them for review, applies under git isolation. Generic over the surface via the `TunableSubject` ABC; ships with `SkillsSubject` (native) and `ExternalProcessSubject` (subprocess-bridged plugins) as reference subjects.

Directly addresses TerrysPOV/ClaudeClaw-Plus#14: when Claude notices repeated multi-step sequences or unmatched user frustration, capture as a new skill via Telegram inline approval, with cooldown on rejection and signed audit trail.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────┐
│  CLI (commander)                                │
│  doctor / cron-run / pending / apply / skip     │
│  / revert / feedback / stats / setup            │
└──────────────────┬──────────────────────────────┘
                   │
         bootstrapEngine(config)
                   │
┌──────────────────▼──────────────────────────────┐
│  Engine                                         │
│   ├─ Registry(TunableSubject[])                 │
│   ├─ ProposalsStore (proposals.jsonl)           │
│   ├─ RefusedStore (refused.jsonl)               │
│   ├─ BranchManager (per-subject git_repo)       │
│   └─ LLMClient (anthropic_api or claude_cli)    │
└──────────────────┬──────────────────────────────┘
                   │
                   ▼
       ┌───────────┴───────────┐
       │                       │
┌──────▼─────────┐    ┌────────▼────────────┐
│ SkillsSubject  │    │ ExternalProcess     │
│ (native, TS)   │    │ Subject (JSON-RPC)  │
└────────────────┘    └─────────────────────┘
```

Storage paths (all under `~/.config/tuner/`):
- `config.yaml` — subject config + overrides
- `proposals.jsonl` — append-only event log (created/applied/refused/reverted)
- `refused.jsonl` — TTL-scoped pattern-signature index
- `audit.jsonl` — append-only audit trail (every state-changing op)
- `state-hashes.jsonl` — per-subject state hash for drift detection
- `.secret` — 32-byte HMAC key (mode 0600)

---

## 2. Functions

### 2.1 Detection

`collectObservations(since: Date) → Observation[]` — each subject scans its data sources for user-feedback signals.

`SkillsSubject` reads Claude Code session JSONLs + Telegram history within the window. Each verbatim is sanitized (`sanitizeObservationContent`) before storage, neutralizing prompt-injection markers (`[system]`, `[INST]`, etc.) before they reach the proposer.

`detectProblems(observations) → Cluster[]` — clusters by signal type:
- ≥`orphan_min_observations` frustrations matching no existing entity → orphan cluster (`new_skill` candidate)
- ≥`min_negative_threshold` corrections on the same entity → patch cluster
- High success rate suppresses (`success_rate > 0.8` → no cluster)

### 2.2 Proposal

`proposeChange(cluster) → UnsignedProposal` returns 1-3 alternatives. The LLM proposer follows a v2.2 diagnose-first prompt:

1. Classify the failure pattern from a named taxonomy.
2. Reject cosmetic-only variants (whitespace, header reorder, copy-only).
3. Each alternative changes behavior, not just form.
4. Each tradeoff names what improves AND what new risk this introduces.
5. Reply must start with `[` (no prose preamble).
6. Language localization piped from `config.proposer.language_preference`.

Taxonomies are subject-specific:

| Subject | Failure modes |
|---|---|
| `skills` patch | `wrong-trigger | vague-instructions | missing-edge-case | wrong-tool-selection | ambiguous-output | over-eager-activation | under-specified-scope | format-mismatch` |
| `skills` new_skill | `recurring-workflow-gap | missing-tool-integration | context-accumulation-need | automation-gap | output-format-need | discovery-shortcut` |
| External plugins | author-defined in plugin code |

A robust JSON extractor (`extractJsonArray`) tolerates models that emit prose or markdown fences before the JSON array.

### 2.3 Apply

`apply(proposal, alternativeId) → Patch` dispatches on `proposal.kind`:

- `patch` / `frontmatter` — modify existing file in place, write `.bak` first
- `new_skill` / `new_*` — create new file in `scan_dirs[0]`, slug from alternative label, timestamp suffix on collision
- `frontmatter-fix` — write corrected frontmatter

Every write is preceded by a path-containment check: target must resolve inside the subject's `scan_dirs` (hardcoded, no override). External subjects must declare `allowedRoots` explicitly.

Each application creates a git branch `tuner/<subject>/<id>-<kind>` in the subject's git repo (`storage.git_repo` or `subjects.<name>.git_repo`), commits the patch, and routes audit events through `audit.jsonl`.

### 2.4 Migration

Two migration paths:

**Python predecessor → TypeScript.** `scripts/migrate-from-python.ts` translates legacy flat-record `proposals.jsonl` into wrapped-event format and populates `refused.jsonl` with the original refusal timestamps preserved (TTL window honored).

**Flat skill → Anthropic directory format.** `SkillsSubject.migrateSkillToDirectory(name)` converts `<name>.md` to `<name>/SKILL.md`, strips tuner-specific fields (`triggers`, `risk_tier`, `auto_merge_default`), returns them for the caller to persist into `config.subjects.skills.overrides.<name>`.

Both paths back up originals (`.python-backup-*` or `.pre-migration-*.bak`, both gitignored via `*.bak*`).

### 2.5 Frontmatter validation

Five compliance rules apply to every skill on every write and every cron tick:

| Rule | Severity | Auto-fix |
|---|---|---|
| `name` field present | error | yes — use directory name |
| `name` matches directory name | error | yes — rename to dirname |
| `description` field present | error | yes — extract from heading + first paragraph |
| `description` ≥30 chars | warning | no — surface as `frontmatter-fix` proposal |
| No legacy tuner fields in frontmatter | error | yes — move to `config.overrides`, atomic write |

Auto-fix runs at three hook points (Section 4.4). Non-autofixable violations enter the standard proposal flow with stable `pattern_signature: skills:<path>:frontmatter-fix`, dedupe-eligible like any other proposal.

### 2.6 Drift detection

Each subject opt-in implements `currentStateHash() → string`. The engine compares per-cycle against `state-hashes.jsonl`; differences fire `subject_state_drift_detected` audit events. `SkillsSubject` hashes file path + mtime + size across all `scan_dirs`. Drift errors are caught and logged (`drift_detection_error`); they never crash a cycle.

### 2.7 Companion `/tuner` skill

A 7-mode skill installed by `tuner setup` that orchestrates user-facing operations:

| Mode | Purpose |
|---|---|
| `setup` | First-run wizard, generates `config.yaml`, dry-run preview |
| `create` | Author a new tunable subject with frontmatter discipline |
| `adjust` | Per-skill or subject-wide tuning of knobs (models, scan_dirs, confidence_floor, max_proposals, scheduling) |
| `audit` | Compute metrics per subject, format compliance, git topology, drift summary, suggested actions |
| `optimize` | Cost analysis, model downgrade suggestions, latency, storage, threshold tuning |
| `tune-prompt` | Audit a subject's proposer prompt against the v2.2 checklist; propose patches with subject-specific taxonomies |
| `report` | Sanitize + draft an upstream issue when something is genuinely framework-broken |

The `/tuner` skill is itself a `TunableSubject` member with `risk_tier: critical` and 30-day cooldown — recursive self-improvement is permitted but rate-limited.

---

## 3. Conditions — when each function fires

### 3.1 Per-cycle (`tuner cron-run`)

Order of operations:

1. **Frontmatter pre-pass** — every subject implementing `runFrontmatterMaintenance()` is invoked. Auto-fixes safe issues. Emits `frontmatter_compliance_summary`.
2. **Drift detection** — `currentStateHash()` compared to last recorded; differences logged.
3. `collectObservations(since)` per subject.
4. `detectProblems(observations)` clusters signals.
5. For each cluster, `proposeChange()`. Three dedup layers consulted before write (Section 5.1).
6. New proposals appended to `proposals.jsonl`, signed with HMAC.
7. Auto-merge eligibility per `subjects.<name>.auto_merge` (boolean or array of allowed kinds). High-risk subjects (`risk_tier: high|critical`) are never auto-merged regardless of config — hardcoded gate.

### 3.2 Manual operations

`tuner apply <id> <alt>` — verifies HMAC signature on the proposal envelope, runs frontmatter pre-pass on the resulting file, writes branch + commit. Idempotent: re-applying an already-applied proposal throws.

`tuner skip <id>` and `tuner feedback <id> no` — record refusal in both `proposals.jsonl` (event:refused) AND `refused.jsonl` (TTL-indexed). Either path alone would be sufficient — both run for defense-in-depth.

`tuner revert <id>` — checks out the proposal branch, runs `git revert`, audit event `reverted`.

### 3.3 Migration triggers

Migration is opportunistic, never automatic:
- `tuner adjust <name>` — Step 2.5 detects flat format and offers conversion.
- `bun scripts/migrate-from-python.ts` — explicit Python predecessor migration, dry-run by default.

### 3.4 Frontmatter validation hooks

Three hooks ensure no manual or programmatic write escapes validation:

1. **Inline post-write** — `apply()` and `migrateSkillToDirectory()` validate after every disk write; auto-fix safe issues atomically.
2. **Per-cycle pre-pass** — see §3.1; catches drift from manual external edits.
3. **Proposal flow** — non-autofixable violations become `frontmatter-fix` proposals routed through the same propose/dedupe/apply pipeline.

### 3.5 LLM availability fallback

`makeLLMClient(config)`:
- If `backend: anthropic_api` AND `ANTHROPIC_API_KEY` set → `AnthropicApiBackend`
- If `backend: anthropic_api` but no key → falls through to `claude_cli` (covers OAuth/keychain setups)
- If `backend: claude_cli` or fallback → `ClaudeCliBackend` (uses `claude --print --model X --append-system-prompt SYSTEM` with prompt on stdin)

If the LLM client throws at construction, `bootstrapEngine` catches and continues without an LLM. Subjects fall through to `fallbackAlternatives()` deterministic templates rather than crashing the cycle.

---

## 4. Protections — designed-in safety properties

### 4.1 Defense-in-depth deduplication

Three independent dedup layers, consulted in order before any proposal is written:

1. `RefusedStore.activeSignatures()` — TTL-scoped (default 30d), reads `refused.jsonl` with schema-fallback for legacy field names (`expires_at` then `ttl_until`).
2. `ProposalsStore.refusedSignatures(subject)` — derived from `event:refused` records in `proposals.jsonl`. Unbounded (no TTL) — guarantees that a refusal is honored even if `refused.jsonl` is corrupt, missing, or wiped.
3. `ProposalsStore.pendingSignatures(subject)` — current `created` events not yet resolved.

A signature must pass all three layers to become a fresh proposal.

### 4.2 Stable `pattern_signature`

Format: `<subject>:<absolute_target_path>:<kind>` (and `<subject>:<orphan-name>:new_skill:<content_hash>` for orphan kinds). Crucially **no date stamp** — the same recurring problem produces the same signature every day, so refusals stick across midnight rollovers.

### 4.3 Path containment

Every disk write validates that the target resolves inside the subject's declared `scan_dirs` (or `allowedRoots` for external subjects). Hardcoded check, no escape hatch. Symlinks are resolved before comparison.

### 4.4 HMAC-signed proposals

Each `Proposal` carries an HMAC-SHA256 signature over its canonical fields, computed against `~/.config/tuner/.secret` (32 bytes, mode 0600). `apply()` verifies before any write; signature mismatch logs `signature_mismatch` and refuses to apply. Defends against tamper of `proposals.jsonl` between propose and apply (CI persistence, NFS mounts, multi-machine sync).

### 4.5 Atomic config writes

When migration moves a field from frontmatter to `config.yaml`, both files are written via tmp+rename. SKILL.md write failure leaves config untouched — no half-applied migrations.

### 4.6 Backup discipline

Every skill mutation creates a `.bak` before write (`.pre-autofix-*.bak`, `.pre-migration-*.bak`, `.bak` inline), gitignored by convention. Rollback is one filesystem rename.

### 4.7 YAML resilience

Malformed YAML frontmatter on any skill is caught at parse time; the offending file is logged with a warning and skipped, leaving the rest of the corpus available. One bad skill cannot crash the scan.

### 4.8 Test isolation

`TUNER_AUDIT_PATH` env var redirects `audit.jsonl` per-process. Tests set it in `beforeEach` so production audit logs stay free of test artifacts. Default falls back to `~/.config/tuner/audit.jsonl` when unset.

### 4.9 Frontmatter auto-validation

Three hooks (§3.4) ensure no skill can persist with missing/invalid frontmatter for more than one cycle. Violations are caught even when introduced by manual external edits outside the tuner flow.

### 4.10 Risk-tier auto-merge gating

`subjects.<name>.auto_merge` may be `true`, `false`, or an array of kinds. Regardless of value, subjects declaring `risk_tier: high` or `risk_tier: critical` are never auto-merged — the gate is hardcoded in `Engine.runCycle`. Trading-ML hyperparameters and similar high-stakes subjects remain human-in-loop.

### 4.11 Anti-loop validation

`SkillsSubject.validate()` refuses to apply a `new_skill` proposal whose generated frontmatter lacks triggers — an empty-trigger skill cannot match anything, would generate further orphan signals, and would loop the proposer. Validation throws before disk write.

### 4.12 Human-only commit convention

The `/tuner` skill explicitly forbids `Co-Authored-By: Claude` or any AI/model attribution in commit messages. Mode `tune-prompt` Step 5 documents this. Convention enforced by review, not by hook.

### 4.13 Auto-fallback to claude_cli

When `ANTHROPIC_API_KEY` is absent (OAuth/keychain deployments), the LLM factory silently falls back to the `claude` CLI rather than throwing. Skills tuner remains operational on platforms without an API key.

---

## 5. Configuration

`~/.config/tuner/config.yaml` schema (Zod-validated, fail-fast on load):

```yaml
models:
  proposer_default: claude-sonnet-4-6
  proposer_high_stakes: claude-opus-4-7
  judge: claude-opus-4-7

llm:
  backend: anthropic_api  # or claude_cli; falls back to cli if key missing

detection:
  confidence_floor: 0.65
  max_proposals_per_run: 5

proposer:
  alternatives_count: 3
  language_preference: en  # or fr-quebec, etc — piped to LLM

subjects:
  skills:
    enabled: true
    proposer: claude-sonnet-4-6
    proposer_for_create: claude-opus-4-7
    auto_merge: [patch, frontmatter, frontmatter-fix]
    scan_dirs: [~/agent/skills, ~/agent/voice-skills-greg/skills]
    git_repo: ~/agent/skills  # optional per-subject; falls back to storage.git_repo
    overrides:
      <skill-name>:
        triggers: ["..."]
        risk_tier: low
        auto_merge_default: true

storage:
  proposals_jsonl: ~/.config/tuner/proposals.jsonl
  refused_jsonl: ~/.config/tuner/refused.jsonl
  git_repo: ~/agent/skills  # default; subjects can override
```

---

## 6. CLI usage

```
tuner doctor                           # env + dependency check
tuner cron-run [--dry] [--since 7d]    # one detection + proposal cycle
tuner pending                          # list pending proposals
tuner apply <id> <alt>                 # apply alternative (A/B/C)
tuner skip <id>                        # refuse proposal (TTL 30d)
tuner revert <id>                      # revert applied proposal via git revert
tuner feedback <id> {yes|yes-but|no}   # post-apply outcome signal
tuner stats                            # counts by event type
tuner setup                            # first-run wizard
```

`cron-run` is the core scheduled entry point (typically `*/15` cron). Designed to detach from the scheduler — long LLM calls do not block subsequent cron ticks.

---

## 7. Telegram integration

Depends on PR #40's `TelegramAdapter`. Each pending proposal renders as a card with inline keyboard `[Save / Skip / Edit first]`. Callbacks carry HMAC-signed envelopes (replay window 15m), verified server-side before apply.

---

## 8. Extension — writing a custom subject

Implement five methods of `TunableSubject`:

```ts
abstract collectObservations(since: Date): Promise<Observation[]>
abstract detectProblems(obs: Observation[]): Promise<Cluster[]>
abstract proposeChange(cluster: Cluster): Promise<UnsignedProposal>
abstract apply(p: Proposal, altId: string): Promise<Patch>
abstract validate(p: UnsignedProposal): Promise<ValidationResult>
```

Optional: `currentStateHash()`, `runFrontmatterMaintenance()`, `scoreSignal()`, `reclassifySignal()`.

For language-agnostic subjects (Python ML, etc.), implement the same surface as JSON-RPC over stdio and wrap with `ExternalProcessSubject`. The plugin template at `examples/external_subject_python_template.py` provides a v2-compliant scaffold.

---

## 9. Testing

243 tests across unit, integration, and adversarial tiers. Notable suites:

- `engine_drift_detection.test.ts` — 10 tests covering hash stability, restart survival, throwing subjects, missing/corrupt state file.
- `engine_concurrency.test.ts` — race condition prevention on concurrent apply.
- `dedup_resilience.test.ts` — defense-in-depth dedup layers, schema fallback, atomic config writes.
- `skills_signature_stability.test.ts` — pattern_signature stability across days.
- `frontmatter_validation.test.ts` — 5 rules, 3 hook integration, idempotence.
- `skills_prompt_injection.test.ts` — verbatim sanitization Tier 1+2.
- `skills_regex_dos.test.ts` — pattern compilation guards.
- `external_process_security.test.ts` — JSON-RPC injection, allowedRoots enforcement.
- `audit_atomicity.test.ts` — append-only invariants under partial writes.
- `audit_chain.test.ts` — documents tamper-detection limitation (no hash chain — single-writer model).
- `e2e_workflow.test.ts` — detect → propose → apply → branch + record full pipeline.

Tests use `TUNER_AUDIT_PATH` env override to keep production audit free of test artifacts.

---

## 10. Stack

Bun ≥1.3, TypeScript 5+, Zod for schema, js-yaml for frontmatter, commander for CLI. Compatible with Anthropic SDK (when `ANTHROPIC_API_KEY` set) or `claude` CLI binary (OAuth/keychain). Node-compatible APIs throughout — no Bun-only primitives in the framework code.
