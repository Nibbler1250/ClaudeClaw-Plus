import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { BaseSubject } from "../../skills-tuner/subjects/base.js";
import { sanitizeObservationContent } from "../../skills-tuner/core/security.js";
import type { LLMClient } from "../../skills-tuner/core/llm.js";
import type {
  Cluster,
  Observation,
  Patch,
  Proposal,
  UnsignedProposal,
  ValidationResult,
} from "../../skills-tuner/core/types.js";
import type { JobSpec, SchedulerBackend } from "../../skills-tuner/schedulers/base.js";
import type { RevertibleSubject } from "../wisecron/types.js";
import type { DateRange, Metric, TelemetryProvider } from "../../skills-tuner/core/telemetry.js";
import { ARTIFACT_SOURCE } from "../../skills-tuner/core/telemetry.js";
import { median, nonzeroRate } from "../../skills-tuner/core/aggregate.js";

/**
 * CronSubject — wisecron-managed `cron` subject (HIGH RISK).
 *
 * What it tunes: systemd-user timer/service pairs prefixed `wisecron-*`
 * (and POSIX crontab entries via SchedulerBackend abstraction).
 *
 * Telemetry source: `journalctl --user -u wisecron-<unit>.service` parsed
 * for exit codes, durations, stale log timestamps, error-rate.
 *
 * Risk class: HIGH — modifies executable schedules. Apply triggers a 5-min
 * observation window in ApplyPipeline; auto-revert on unit failure.
 */
export interface CronSubjectConfig {
  llm?: LLMClient;
  scheduler?: SchedulerBackend;
  /** Glob for journalctl unit filter. Default: 'wisecron-*.service'. */
  journalUnitGlob?: string;
  /** Required unit prefix. Default: 'wisecron-'. */
  unitPrefix?: string;
  /**
   * Allowlist of directory roots commands may reference. Anything resolving
   * outside is rejected at validate() and apply(). Default: ~/.config,
   * ~/agent, ~/Projects, /usr/bin, /bin.
   */
  allowedCommandRoots?: string[];
  /**
   * Injected journalctl runner — receives the prepared args and returns
   * raw stdout. Default spawns `journalctl --user`. Tests pass a fixture.
   */
  journalRunner?: (args: string[]) => Promise<string>;
  /**
   * Maximum age (hours) before a unit with no successful run is treated
   * as stale. Default 168h (7d) per SPEC.
   */
  staleThresholdHours?: number;
  /**
   * Cost attribution (OutcomeLoop `cron_cost`): substrings that, when present
   * in a `session_cost` sample's `job` label, mark that session as
   * cron-originated. The cost store's `job` is free-text (often a raw prompt
   * prefix), so attribution is substring-based, not exact. Default matches
   * scheduler-dispatched sessions (`source="cron"`) and wisecron unit names.
   */
  costJobMatch?: string[];
}

/** One parsed journalctl entry (JSON line). */
interface JournalEntry {
  unit: string;
  timestamp: Date;
  exitCode: number | null;
  message: string;
}

/** Aggregated per-unit health snapshot. */
interface UnitHealth {
  unit: string;
  runs: number;
  errors: number;
  errorRate: number;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  command: string | null;
}

const DEFAULT_STALE_HOURS = 168;

export class CronSubject extends BaseSubject implements RevertibleSubject {
  readonly name = "cron";
  readonly risk_tier = "high" as const;
  readonly auto_merge_default = false;
  readonly supports_creation = false;
  readonly orphan_min_observations = 3;

  private readonly llm?: LLMClient;
  private readonly scheduler?: SchedulerBackend;
  private readonly journalUnitGlob: string;
  private readonly unitPrefix: string;
  private readonly allowedCommandRoots: string[];
  private readonly journalRunner: (args: string[]) => Promise<string>;
  private readonly staleThresholdHours: number;
  private readonly costJobMatch: string[];

  constructor(opts: CronSubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    this.scheduler = opts.scheduler;
    this.journalUnitGlob = opts.journalUnitGlob ?? "wisecron-*.service";
    this.unitPrefix = opts.unitPrefix ?? "wisecron-";
    this.allowedCommandRoots = (
      opts.allowedCommandRoots ?? [
        `${homedir()}/.config`,
        `${homedir()}/agent`,
        `${homedir()}/Projects`,
        "/usr/bin",
        "/bin",
      ]
    ).map((p) => resolve(p));
    this.journalRunner = opts.journalRunner ?? defaultJournalRunner;
    this.staleThresholdHours = opts.staleThresholdHours ?? DEFAULT_STALE_HOURS;
    this.costJobMatch = opts.costJobMatch ?? ['source="cron"', this.unitPrefix];
  }

  async collectObservations(since: Date): Promise<Observation[]> {
    const args = [
      "--user",
      "-u",
      this.journalUnitGlob,
      "--since",
      since.toISOString(),
      "--output",
      "json",
    ];

    let raw: string;
    try {
      raw = await this.journalRunner(args);
    } catch {
      return [];
    }

    const entries = parseJournalJsonLines(raw);
    if (entries.length === 0) return [];

    const healthByUnit = aggregateHealth(entries);
    const observations: Observation[] = [];
    const now = new Date();

    for (const [unit, health] of healthByUnit) {
      // Emit observation for any unit with errors OR a stale gap.
      const isStale =
        health.lastSuccessAt !== null &&
        (now.getTime() - health.lastSuccessAt.getTime()) / 3_600_000 > this.staleThresholdHours;
      const hasErrors = health.errors > 0;

      if (!hasErrors && !isStale) continue;

      const signal_type =
        health.errorRate > 0.5 ? "correction" : isStale ? "orphan" : "repeated_trigger";

      const payload = sanitizeObservationContent(
        JSON.stringify({
          unit,
          runs: health.runs,
          errors: health.errors,
          error_rate: Math.round(health.errorRate * 100) / 100,
          last_run_at: health.lastRunAt?.toISOString() ?? null,
          last_success_at: health.lastSuccessAt?.toISOString() ?? null,
          stale: isStale,
        }),
        500,
      );

      observations.push({
        session_id: `cron-${unit}-${now.getTime()}`,
        observed_at: now,
        signal_type,
        verbatim: payload,
        metadata: {
          subject: "cron",
          unit,
          error_rate: health.errorRate,
          runs: health.runs,
          stale: isStale,
          command: health.command,
        },
      });
    }

    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length === 0) return [];

    const buckets = new Map<string, Observation[]>();
    // Detect redundancy: units sharing the same command.
    const commandToUnits = new Map<string, Set<string>>();

    for (const obs of observations) {
      const meta = obs.metadata as Record<string, unknown>;
      const errorRate = (meta.error_rate as number | undefined) ?? 0;
      const stale = (meta.stale as boolean | undefined) ?? false;
      const unit = (meta.unit as string) ?? "unknown";
      const command = meta.command as string | null | undefined;

      if (errorRate > 0.5) push(buckets, "high-error-rate", obs);
      if (stale) push(buckets, "stale-unit", obs);

      if (command) {
        if (!commandToUnits.has(command)) commandToUnits.set(command, new Set());
        commandToUnits.get(command)?.add(unit);
      }
    }

    for (const [command, units] of commandToUnits) {
      if (units.size > 1) {
        const redundantObs = observations.filter((o) => {
          const u = (o.metadata as Record<string, unknown>).unit as string;
          return units.has(u) && (o.metadata as Record<string, unknown>).command === command;
        });
        for (const o of redundantObs) push(buckets, "redundant-command", o);
      }
    }

    const clusters: Cluster[] = [];
    for (const [kind, obs] of buckets) {
      const units = Array.from(
        new Set(obs.map((o) => (o.metadata as Record<string, unknown>).unit as string)),
      );
      const avgErrorRate =
        obs.reduce(
          (s, o) => s + (((o.metadata as Record<string, unknown>).error_rate as number) ?? 0),
          0,
        ) / obs.length;
      clusters.push({
        id: `cron-${kind}`,
        subject: "cron",
        observations: obs,
        frequency: obs.length,
        success_rate: Math.max(0, 1 - avgErrorRate),
        sentiment: kind === "high-error-rate" ? "negative" : "neutral",
        subjects_touched: units,
      });
    }
    return clusters;
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const kind = cluster.id.replace(/^cron-/, "");
    const firstObs = cluster.observations[0];
    if (!firstObs) {
      throw new Error("cron-subject.proposeChange: cluster has no observations");
    }
    const meta = firstObs.metadata as Record<string, unknown>;
    const unit = (meta.unit as string) ?? "unknown.service";
    const command = (meta.command as string | null) ?? "/bin/true";

    // Default schedule values used by the templated alternatives. We don't
    // call the LLM in tests; production wires this method to do so.
    const adjustedSchedule = "*-*-* */12:00:00";

    const alternatives = [
      {
        id: "adjust-schedule",
        label: `Adjust schedule for ${unit}`,
        diff_or_content: JSON.stringify({
          name: unit.replace(/\.service$/, ""),
          description: `wisecron: adjusted schedule (${kind})`,
          schedule: adjustedSchedule,
          command,
        }),
        tradeoff: "Less frequent runs → fewer errors but lower coverage.",
      },
      {
        id: "disable-unit",
        label: `Disable ${unit}`,
        diff_or_content: JSON.stringify({
          name: unit.replace(/\.service$/, ""),
          description: `wisecron: disabled (${kind})`,
          schedule: "never",
          command,
          disabled: true,
        }),
        tradeoff: "Stops failures but loses functionality entirely.",
      },
      {
        id: "fix-command",
        label: `Fix command for ${unit}`,
        diff_or_content: JSON.stringify({
          name: unit.replace(/\.service$/, ""),
          description: `wisecron: fixed command path (${kind})`,
          schedule: "*-*-* *:00:00",
          command,
        }),
        tradeoff: "Reuses inferred command; manual review recommended.",
      },
    ];

    return {
      id: Date.now(),
      cluster_id: cluster.id,
      subject: "cron",
      kind: "cron_change",
      target_path: unit,
      alternatives,
      pattern_signature: `cron:${kind}:${unit}`,
      created_at: new Date(),
    };
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    if (!this.scheduler) {
      throw new Error("cron-subject.apply: no SchedulerBackend configured");
    }
    const alt = proposal.alternatives.find((a) => a.id === alternativeId);
    if (!alt) {
      throw new Error(`cron-subject.apply: alternative ${alternativeId} not found`);
    }

    const spec = parseJobSpecJson(alt.diff_or_content);
    this.assertUnitNameAllowed(spec.name);
    this.assertCommandRootAllowed(spec.command);

    // Remove first (idempotent — backend no-ops if missing), then create.
    await this.scheduler.remove(spec.name);
    if (spec.schedule !== "never") {
      await this.scheduler.create({
        name: spec.name,
        description: spec.description,
        schedule: spec.schedule,
        command: spec.command,
      });
    }

    return {
      target_path: proposal.target_path,
      kind: "cron_change",
      applied_content: JSON.stringify(spec),
    };
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    if (patch.kind !== "cron_change") {
      return { valid: false, reason: `unexpected kind: ${patch.kind}` };
    }
    let spec: SerializedJobSpec;
    try {
      spec = parseJobSpecJson(patch.applied_content);
    } catch (e) {
      return { valid: false, reason: `malformed applied_content: ${(e as Error).message}` };
    }
    try {
      this.assertUnitNameAllowed(spec.name);
    } catch (e) {
      return { valid: false, reason: (e as Error).message };
    }
    try {
      this.assertCommandRootAllowed(spec.command);
    } catch (e) {
      return { valid: false, reason: (e as Error).message };
    }
    if (spec.schedule !== "never" && !isValidOnCalendar(spec.schedule)) {
      return { valid: false, reason: `invalid OnCalendar expression: ${spec.schedule}` };
    }
    return { valid: true };
  }

  /**
   * Snapshot the prior JobSpec from the SchedulerBackend (not the service
   * file on disk — the unit name is the target, not a path). When no
   * scheduler is wired or the unit is absent, return a sentinel spec with
   * schedule='never' so revert() removes any orphan registration.
   */
  async snapshotInverse(target: string): Promise<string> {
    const name = target.replace(/\.service$/, "");
    if (!this.scheduler) {
      return JSON.stringify({ name, description: "", schedule: "never", command: "/bin/true" });
    }
    let jobs: Awaited<ReturnType<NonNullable<typeof this.scheduler>["list"]>>;
    try {
      jobs = await this.scheduler.list();
    } catch {
      return JSON.stringify({ name, description: "", schedule: "never", command: "/bin/true" });
    }
    const found = jobs.find((j) => j.name === name);
    if (!found) {
      return JSON.stringify({ name, description: "", schedule: "never", command: "/bin/true" });
    }
    return JSON.stringify({
      name: found.name,
      description: "",
      schedule: found.schedule,
      command: found.command,
    });
  }

  async revert(inversePatch: Patch): Promise<void> {
    if (!this.scheduler) {
      throw new Error("cron-subject.revert: no SchedulerBackend configured");
    }
    const spec = parseJobSpecJson(inversePatch.applied_content);
    this.assertUnitNameAllowed(spec.name);

    // Always remove the current registration first (no-op if absent).
    await this.scheduler.remove(spec.name);

    // Inverse patch may represent "did not exist before" via schedule='never'.
    if (spec.schedule === "never") return;

    this.assertCommandRootAllowed(spec.command);
    await this.scheduler.create({
      name: spec.name,
      description: spec.description,
      schedule: spec.schedule,
      command: spec.command,
    });
  }

  async healthCheck(): Promise<{
    producer_found: boolean;
    sample_event_match_rate: number;
    reason?: string;
  }> {
    // Look back 7 days for any journal entries; presence of at least one
    // wisecron-* unit entry means the producer is wired up.
    const since = new Date(Date.now() - 7 * 86_400_000);
    const args = [
      "--user",
      "-u",
      this.journalUnitGlob,
      "--since",
      since.toISOString(),
      "--output",
      "json",
    ];
    let raw = "";
    try {
      raw = await this.journalRunner(args);
    } catch (e) {
      return {
        producer_found: false,
        sample_event_match_rate: 0,
        reason: `journalctl runner failed: ${(e as Error).message.slice(0, 120)}`,
      };
    }
    const entries = parseJournalJsonLines(raw);
    if (entries.length === 0) {
      return {
        producer_found: false,
        sample_event_match_rate: 0,
        reason: `no '${this.journalUnitGlob}' entries in last 7d (no wisecron units installed yet?)`,
      };
    }
    const matching = entries.filter((e) => e.unit.startsWith(this.unitPrefix)).length;
    return {
      producer_found: true,
      sample_event_match_rate: matching / entries.length,
    };
  }

  /**
   * OutcomeLoop fitness metrics for the cron subject.
   *
   * Target — `cron_cost` (Tier 1, `session_cost`): median USD of cron-originated
   * Claude sessions over the window. Lower is better. Guarded against Goodhart
   * by TWO companions, because the cheapest way to "reduce cron cost" is to
   * neuter or delete crons:
   *  - `active_cron_count` (Tier 1b, artifact): count of still-active managed
   *    units. Always activatable (scans scheduler state, no host stream), so the
   *    no-regression rule has teeth even where no runtime stream exists. A cost
   *    drop that comes from killing units shows up here as a regression.
   *  - `critical_fire_success` (Tier 1, `cron_run`): success rate of critical
   *    fires. The catalogue's intended guardrail, but `cron_run` has no producer
   *    in the reference host, so it degrades to inactive (logged) — kept so it
   *    activates automatically the day a host emits the stream.
   *
   * NO single-number maximisation: `cron_cost` is never scored alone.
   */
  fitnessSignals(): Metric[] {
    return [
      {
        name: "cron_cost",
        source: "session_cost",
        kind: "verifiable",
        direction: "lower_is_better",
        windowDays: 7,
        guardrails: ["active_cron_count", "critical_fire_success"],
      },
      {
        name: "active_cron_count",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "higher_is_better",
        windowDays: 7,
      },
      {
        name: "critical_fire_success",
        source: "cron_run",
        kind: "verifiable",
        direction: "higher_is_better",
        windowDays: 7,
      },
    ];
  }

  /**
   * Measure the declared fitness metrics over `range`. Telemetry is read ONLY
   * through `provider.query(...)` — never the cost store directly. Aggregation
   * is outlier-robust (median), never a raw sum: cost is spiky (one debug
   * session dwarfs a week of crons).
   *
   * A metric is OMITTED from the result when it has no data (no cron-attributed
   * sessions, no scheduler, no `cron_run` producer) rather than reported as 0 —
   * the loop then simply doesn't snapshot/score it, which is the correct
   * degrade-gracefully behaviour.
   */
  async measureFitness(
    range: DateRange,
    provider: TelemetryProvider,
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};

    // ── Tier 1: cron_cost (session_cost) ────────────────────────────────────
    // Query broadly (job is free-text → exact label filter is brittle) then
    // post-filter to cron-originated sessions on the job label.
    const costSamples = await provider.query("session_cost", range);
    const cronCosts = costSamples
      .filter((s) => this.isCronAttributed(s.labels))
      .map((s) => s.value);
    if (cronCosts.length > 0) out.cron_cost = median(cronCosts);

    // ── Tier 1b: active_cron_count (artifact — scheduler state) ─────────────
    const activeCount = await this.countActiveUnits();
    if (activeCount !== null) out.active_cron_count = activeCount;

    // ── Tier 1: critical_fire_success (cron_run) ────────────────────────────
    // No producer in the reference host → query returns []; metric omitted.
    // Host contract for cron_run: value 0 = clean exit, nonzero = failure.
    const fireSamples = await provider.query("cron_run", range);
    if (fireSamples.length > 0) {
      out.critical_fire_success = 1 - nonzeroRate(fireSamples.map((s) => s.value));
    }

    return out;
  }

  /** True if a cost sample's `job` label marks it cron-originated. */
  private isCronAttributed(labels?: Record<string, string>): boolean {
    const job = labels?.job;
    if (!job) return false;
    return this.costJobMatch.some((needle) => job.includes(needle));
  }

  /**
   * Count managed units the scheduler reports as active. Returns null when no
   * scheduler is wired (metric simply doesn't activate). Artifact-tier: reads
   * managed state, no telemetry stream.
   */
  private async countActiveUnits(): Promise<number | null> {
    if (!this.scheduler) return null;
    let jobs: Awaited<ReturnType<NonNullable<typeof this.scheduler>["list"]>>;
    try {
      jobs = await this.scheduler.list();
    } catch {
      return null;
    }
    return jobs.filter((j) => j.status === "active").length;
  }

  private assertUnitNameAllowed(name: string): void {
    if (!name.startsWith(this.unitPrefix)) {
      throw new Error(`unit name must start with '${this.unitPrefix}': got '${name}'`);
    }
  }

  private assertCommandRootAllowed(command: string): void {
    // Extract the first absolute path-looking token from the command and
    // verify it falls under an allowed root. Empty or relative commands pass
    // (validateJobCommand at the backend layer handles emptiness/control chars).
    const match = command.match(/(\/[^\s]+)/);
    if (!match) return;
    const target = resolve(match[1]!);
    for (const root of this.allowedCommandRoots) {
      if (target === root || target.startsWith(`${root}/`)) return;
    }
    throw new Error(`command path outside allowed roots: ${target}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface SerializedJobSpec extends JobSpec {
  disabled?: boolean;
}

function parseJobSpecJson(s: string): SerializedJobSpec {
  const parsed = JSON.parse(s);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof parsed.name !== "string" ||
    typeof parsed.schedule !== "string" ||
    typeof parsed.command !== "string"
  ) {
    throw new Error("JobSpec missing required string fields (name/schedule/command)");
  }
  return parsed as SerializedJobSpec;
}

function parseJournalJsonLines(raw: string): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    // journalctl --user emits `_SYSTEMD_USER_UNIT` for user-scope services
    // and `_SYSTEMD_UNIT` only for system-scope. Wisecron timers run under
    // --user, so omitting the user variant silently dropped every entry.
    const unit =
      (parsed._SYSTEMD_USER_UNIT as string) ??
      (parsed._SYSTEMD_UNIT as string) ??
      (parsed.UNIT as string) ??
      "";
    if (!unit) continue;

    // journalctl reports timestamps in microseconds-since-epoch as a string.
    const tsRaw = parsed.__REALTIME_TIMESTAMP as string | undefined;
    let timestamp = new Date();
    if (tsRaw) {
      const usec = Number(tsRaw);
      if (!Number.isNaN(usec)) timestamp = new Date(Math.floor(usec / 1000));
    }

    // Exit code surfaces as EXIT_STATUS on terminal entries; other entries omit it.
    let exitCode: number | null = null;
    const exitStatus = parsed.EXIT_STATUS;
    if (typeof exitStatus === "string") {
      const parsedExit = parseInt(exitStatus, 10);
      if (!Number.isNaN(parsedExit)) exitCode = parsedExit;
    } else if (typeof exitStatus === "number") {
      exitCode = exitStatus;
    }

    const message = sanitizeObservationContent(String(parsed.MESSAGE ?? ""), 500);

    out.push({ unit, timestamp, exitCode, message });
  }
  return out;
}

function aggregateHealth(entries: JournalEntry[]): Map<string, UnitHealth> {
  const map = new Map<string, UnitHealth>();
  for (const e of entries) {
    let h = map.get(e.unit);
    if (!h) {
      h = {
        unit: e.unit,
        runs: 0,
        errors: 0,
        errorRate: 0,
        lastRunAt: null,
        lastSuccessAt: null,
        command: null,
      };
      map.set(e.unit, h);
    }
    if (e.exitCode !== null) {
      h.runs += 1;
      if (e.exitCode !== 0) h.errors += 1;
      else if (!h.lastSuccessAt || e.timestamp > h.lastSuccessAt) h.lastSuccessAt = e.timestamp;
    }
    if (!h.lastRunAt || e.timestamp > h.lastRunAt) h.lastRunAt = e.timestamp;

    // ExecStart/MESSAGE may carry the command line — opportunistic capture.
    const cmdMatch = e.message.match(/(?:ExecStart=|Started)\s*(.+?)(?:\.\s*$|$)/);
    if (cmdMatch && !h.command) h.command = cmdMatch[1]?.trim();
  }
  for (const h of map.values()) {
    h.errorRate = h.runs === 0 ? 0 : h.errors / h.runs;
  }
  return map;
}

function isValidOnCalendar(spec: string): boolean {
  if (typeof spec !== "string" || spec.trim().length === 0) return false;
  if (spec.length > 200) return false;
  if (spec.includes("\u0000") || spec.includes("\r") || spec.includes("\n")) return false;
  // Accept either a 5-field POSIX cron OR a systemd OnCalendar shape.
  // Conservative regex: digits, *, /, ,, -, :, letters (for Mon..Sun, weekly, daily).
  return /^[A-Za-z0-9*/,\-:\s]+$/.test(spec);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  let arr = map.get(key);
  if (!arr) {
    arr = [];
    map.set(key, arr);
  }
  arr.push(value);
}

async function defaultJournalRunner(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("journalctl", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`journalctl exited ${code}: ${err.slice(0, 200)}`));
      else resolve(out);
    });
  });
}
