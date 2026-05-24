import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import type { RevertibleSubject } from "../wisecron/types.js";
import type { DateRange, Metric, TelemetryProvider } from "../../skills-tuner/core/telemetry.js";
import { ARTIFACT_SOURCE } from "../../skills-tuner/core/telemetry.js";
import { nonzeroRate } from "../../skills-tuner/core/aggregate.js";

const BROKEN_MIN_CALLS = 100;
const BROKEN_SUCCESS_RATE = 0.5;
const DEAD_WINDOW_DAYS = 90;
const TRUST_BLOCKED_THRESHOLD = 0.7;

interface ToolStats {
  server: string;
  tool: string;
  calls: number;
  successes: number;
  blocked: number;
  lastCallAt: Date | null;
  trustScore: number;
}

/**
 * McpPluginSubject — wisecron-managed MCP plugin allowedTools tuner (MEDIUM).
 */
export interface McpPluginSubjectConfig {
  llm?: LLMClient;
  /** Operations audit log. Default: ~/.claudeclaw/journal/operations.jsonl. */
  auditLog?: string;
  /** Optional MCP settings path (target_path for proposals). */
  settingsPath?: string;
  /** Injected event reader for tests. */
  auditReader?: (path: string, since: Date) => Array<Record<string, unknown>>;
}

export class McpPluginSubject extends BaseSubject implements RevertibleSubject {
  readonly name = "mcp_plugin";
  readonly risk_tier = "medium" as const;
  readonly auto_merge_default = false;
  readonly supports_creation = false;

  private readonly llm?: LLMClient;
  private readonly auditLog: string;
  private readonly settingsPath: string;
  private readonly auditReader: (path: string, since: Date) => Array<Record<string, unknown>>;

  constructor(opts: McpPluginSubjectConfig = {}) {
    super();
    this.llm = opts.llm;
    this.auditLog = expandHome(
      opts.auditLog ?? join(homedir(), ".claudeclaw", "journal", "operations.jsonl"),
    );
    this.settingsPath = expandHome(
      opts.settingsPath ?? join(homedir(), ".claude", "settings.json"),
    );
    this.auditReader = opts.auditReader ?? defaultAuditReader;
  }

  async collectObservations(since: Date): Promise<Observation[]> {
    const events = this.auditReader(this.auditLog, since);
    if (events.length === 0) return [];

    const stats = new Map<string, ToolStats>();
    for (const ev of events) {
      if (ev.type !== "mcp_tool_call") continue;
      const server = String(ev.server ?? "unknown");
      const tool = String(ev.tool ?? "unknown");
      const key = `${server}::${tool}`;
      let s = stats.get(key);
      if (!s) {
        s = {
          server,
          tool,
          calls: 0,
          successes: 0,
          blocked: 0,
          lastCallAt: null,
          trustScore: Number(ev.trust_score ?? 0),
        };
        stats.set(key, s);
      }
      s.calls += 1;
      if (ev.success === true || ev.ok === true) s.successes += 1;
      if (ev.blocked === true) s.blocked += 1;
      const ts = ev.ts;
      const tsDate = typeof ts === "string" || typeof ts === "number" ? new Date(ts) : null;
      if (tsDate && (!s.lastCallAt || tsDate > s.lastCallAt)) s.lastCallAt = tsDate;
      if (typeof ev.trust_score === "number") s.trustScore = ev.trust_score as number;
    }

    const now = new Date();
    const observations: Observation[] = [];
    for (const s of stats.values()) {
      const successRate = s.calls === 0 ? 1 : s.successes / s.calls;
      const ageDays = s.lastCallAt
        ? (now.getTime() - s.lastCallAt.getTime()) / 86_400_000
        : Infinity;

      observations.push({
        session_id: `mcp-${s.server}-${s.tool}-${now.getTime()}`,
        observed_at: now,
        signal_type:
          s.calls >= BROKEN_MIN_CALLS && successRate < BROKEN_SUCCESS_RATE
            ? "correction"
            : s.blocked > 0 && s.trustScore > TRUST_BLOCKED_THRESHOLD
              ? "repeated_trigger"
              : "orphan",
        verbatim: sanitizeObservationContent(
          JSON.stringify({
            server: s.server,
            tool: s.tool,
            calls: s.calls,
            success_rate: Math.round(successRate * 100) / 100,
            blocked: s.blocked,
            trust_score: s.trustScore,
            age_days: Number.isFinite(ageDays) ? Math.round(ageDays) : null,
          }),
          500,
        ),
        metadata: {
          subject: "mcp_plugin",
          server: s.server,
          tool: s.tool,
          calls: s.calls,
          success_rate: successRate,
          blocked: s.blocked,
          trust_score: s.trustScore,
          age_days: Number.isFinite(ageDays) ? ageDays : null,
        },
      });
    }
    return observations;
  }

  async detectProblems(observations: Observation[]): Promise<Cluster[]> {
    if (observations.length === 0) return [];
    const broken: Observation[] = [];
    const dead: Observation[] = [];
    const blockedAllow: Observation[] = [];

    for (const obs of observations) {
      const meta = obs.metadata as Record<string, unknown>;
      const calls = (meta.calls as number) ?? 0;
      const successRate = (meta.success_rate as number) ?? 1;
      const blocked = (meta.blocked as number) ?? 0;
      const trust = (meta.trust_score as number) ?? 0;
      const ageDays = meta.age_days as number | null;

      if (calls >= BROKEN_MIN_CALLS && successRate < BROKEN_SUCCESS_RATE) broken.push(obs);
      else if (calls === 0 || (ageDays !== null && ageDays > DEAD_WINDOW_DAYS)) dead.push(obs);
      else if (blocked > 0 && trust > TRUST_BLOCKED_THRESHOLD) blockedAllow.push(obs);
    }

    const clusters: Cluster[] = [];
    if (broken.length > 0) clusters.push(makeCluster("mcp-broken", broken, 0.2, "negative"));
    if (dead.length > 0) clusters.push(makeCluster("mcp-dead", dead, 0.0, "neutral"));
    if (blockedAllow.length > 0)
      clusters.push(makeCluster("mcp-blocked-allow", blockedAllow, 0.6, "neutral"));
    return clusters;
  }

  async proposeChange(cluster: Cluster): Promise<UnsignedProposal> {
    const firstObs = cluster.observations[0];
    if (!firstObs) throw new Error("mcp-plugin-subject.proposeChange: cluster empty");
    const meta = firstObs.metadata as Record<string, unknown>;
    const server = meta.server as string;
    const tool = meta.tool as string;

    let settings: Record<string, unknown> = { allowedTools: [] };
    if (existsSync(this.settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(this.settingsPath, "utf8"));
      } catch {
        /* keep default */
      }
    }

    const allowed = Array.isArray(settings.allowedTools)
      ? [...(settings.allowedTools as string[])]
      : [];
    const removeTool = `mcp__${server}__${tool}`;
    const removed = allowed.filter((t) => t !== removeTool);
    const added = allowed.includes(removeTool) ? allowed : [...allowed, removeTool];
    const disabledServer = {
      ...settings,
      mcpServers: {
        ...((settings.mcpServers as Record<string, unknown>) ?? {}),
        [server]: { disabled: true },
      },
    };

    return {
      id: Date.now(),
      cluster_id: cluster.id,
      subject: "mcp_plugin",
      kind: "patch",
      target_path: this.settingsPath,
      alternatives: [
        {
          id: "remove-tool",
          label: `Remove ${removeTool} from allowedTools`,
          diff_or_content: stableJson({ ...settings, allowedTools: removed }),
          tradeoff: "Stops dead calls; reversible.",
        },
        {
          id: "add-tool",
          label: `Add ${removeTool} to allowedTools`,
          diff_or_content: stableJson({ ...settings, allowedTools: added }),
          tradeoff: "Unblocks high-trust tool; widens surface.",
        },
        {
          id: "disable-server",
          label: `Disable MCP server ${server}`,
          diff_or_content: stableJson(disabledServer),
          tradeoff: "Heavy-handed; cuts all tools from that server.",
        },
      ],
      pattern_signature: `mcp_plugin:${cluster.id}:${server}:${tool}`,
      created_at: new Date(),
    };
  }

  async apply(proposal: Proposal, alternativeId: string): Promise<Patch> {
    const alt = proposal.alternatives.find((a) => a.id === alternativeId);
    if (!alt) throw new Error(`mcp-plugin-subject.apply: alternative ${alternativeId} not found`);
    // Parse + restringify to guarantee stable key order even if alt source skipped it.
    const parsed = JSON.parse(alt.diff_or_content);
    const normalized = stableJson(parsed);

    if (existsSync(proposal.target_path)) {
      copyFileSync(proposal.target_path, `${proposal.target_path}.bak`);
    }
    writeFileSync(proposal.target_path, normalized, "utf8");
    return {
      target_path: proposal.target_path,
      kind: "patch",
      applied_content: normalized,
    };
  }

  async validate(patch: Patch): Promise<ValidationResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(patch.applied_content);
    } catch (e) {
      return { valid: false, reason: `not valid JSON: ${(e as Error).message}` };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { valid: false, reason: "JSON must be an object" };
    }
    const obj = parsed as Record<string, unknown>;
    if ("allowedTools" in obj) {
      if (!Array.isArray(obj.allowedTools)) {
        return { valid: false, reason: "allowedTools must be an array" };
      }
      if (!(obj.allowedTools as unknown[]).every((t) => typeof t === "string")) {
        return { valid: false, reason: "allowedTools must contain only strings" };
      }
    }
    return { valid: true };
  }

  async revert(inversePatch: Patch): Promise<void> {
    // Roundtrip parse to keep formatting stable + reject malformed inputs early.
    JSON.parse(inversePatch.applied_content);
    writeFileSync(inversePatch.target_path, inversePatch.applied_content, "utf8");
  }

  async healthCheck(): Promise<{
    producer_found: boolean;
    sample_event_match_rate: number;
    reason?: string;
  }> {
    if (!existsSync(this.auditLog)) {
      return {
        producer_found: false,
        sample_event_match_rate: 0,
        reason: `auditLog does not exist: ${this.auditLog}`,
      };
    }
    const since = new Date(Date.now() - 7 * 86_400_000);
    let events: Array<Record<string, unknown>>;
    try {
      events = this.auditReader(this.auditLog, since);
    } catch (e) {
      return {
        producer_found: false,
        sample_event_match_rate: 0,
        reason: `auditReader failed: ${(e as Error).message.slice(0, 120)}`,
      };
    }
    if (events.length === 0) {
      return {
        producer_found: false,
        sample_event_match_rate: 0,
        reason: `no audit events in last 7d at ${this.auditLog}`,
      };
    }
    const mcpCalls = events.filter((e) => e.type === "mcp_tool_call").length;
    return {
      producer_found: true,
      sample_event_match_rate: mcpCalls / events.length,
      reason:
        mcpCalls === 0
          ? `${events.length} audit events but 0 mcp_tool_call entries — instrumentation missing?`
          : undefined,
    };
  }

  /**
   * OutcomeLoop fitness for the mcp_plugin subject (MEDIUM risk).
   *
   * Target — `mcp_tool_failure_rate` (Tier 1, `tool_call`): fraction of MCP tool
   * calls that failed or were blocked over the window. Lower is better. The
   * gameable shortcut is to empty `allowedTools` (no calls → no failures), so it
   * is guarded by `mcp_allowed_tool_count` (Tier 1b artifact, higher_is_better) —
   * a failure-rate drop achieved by removing tools regresses the guardrail.
   * `mcp_allowed_tool_defect_count` (Tier 1b artifact): always-on scan of the
   * managed settings for duplicate / empty allowlist entries.
   */
  fitnessSignals(): Metric[] {
    return [
      {
        name: "mcp_tool_failure_rate",
        source: "tool_call",
        kind: "verifiable",
        direction: "lower_is_better",
        windowDays: 7,
        guardrails: ["mcp_allowed_tool_count"],
      },
      {
        name: "mcp_allowed_tool_defect_count",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "lower_is_better",
        windowDays: 1,
      },
      {
        name: "mcp_allowed_tool_count",
        source: ARTIFACT_SOURCE,
        kind: "verifiable",
        direction: "higher_is_better",
        windowDays: 7,
      },
    ];
  }

  /**
   * Telemetry read ONLY via `provider.query("tool_call", …)`; failure rate is a
   * rate (outlier-robust by construction), not a sum. The artifact metrics scan
   * the managed settings file directly and are omitted only when that file is
   * absent (an empty/absent `allowedTools` legitimately measures as 0).
   */
  async measureFitness(
    range: DateRange,
    provider: TelemetryProvider,
  ): Promise<Record<string, number>> {
    const out: Record<string, number> = {};

    // ── Tier 1: tool_call stream (value 1 = failed/blocked, 0 = ok) ─────────
    const samples = await provider.query("tool_call", range);
    if (samples.length > 0) {
      out.mcp_tool_failure_rate = nonzeroRate(samples.map((s) => s.value));
    }

    // ── Tier 1b: artifact scan of allowedTools ──────────────────────────────
    const scan = this.scanAllowedTools();
    if (scan !== null) {
      out.mcp_allowed_tool_count = scan.count;
      out.mcp_allowed_tool_defect_count = scan.defects;
    }

    return out;
  }

  /**
   * Scan the managed settings `allowedTools`. defects = duplicate + empty
   * entries. Returns null when the settings file is absent (metric doesn't
   * measure); an existing file with no `allowedTools` measures as `{0,0}`.
   */
  private scanAllowedTools(): { count: number; defects: number } | null {
    if (!existsSync(this.settingsPath)) return null;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(this.settingsPath, "utf8"));
    } catch {
      return null;
    }
    const allowed = Array.isArray(parsed.allowedTools) ? (parsed.allowedTools as unknown[]) : [];
    const seen = new Set<string>();
    let defects = 0;
    for (const t of allowed) {
      if (typeof t !== "string" || t.trim().length === 0) {
        defects += 1;
        continue;
      }
      if (seen.has(t)) defects += 1;
      else seen.add(t);
    }
    return { count: allowed.length, defects };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function makeCluster(
  id: string,
  obs: Observation[],
  successRate: number,
  sentiment: "negative" | "neutral" | "positive",
): Cluster {
  return {
    id,
    subject: "mcp_plugin",
    observations: obs,
    frequency: obs.length,
    success_rate: successRate,
    sentiment,
    subjects_touched: obs.map(
      (o) =>
        `${(o.metadata as Record<string, unknown>).server}::${(o.metadata as Record<string, unknown>).tool}`,
    ),
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, sortReplacer, 2);
}

function sortReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

function defaultAuditReader(path: string, since: Date): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const events: Array<Record<string, unknown>> = [];
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj !== "object" || obj === null) continue;
      const ts = (obj as Record<string, unknown>).ts;
      if (ts) {
        const tsDate = new Date(ts as string | number);
        if (tsDate < since) continue;
      }
      events.push(obj as Record<string, unknown>);
    } catch {}
  }
  return events;
}
