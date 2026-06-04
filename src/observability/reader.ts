/**
 * The observability hub's read-only data layer.
 *
 * Auto-discovers plugins from the distinct `plugin` labels in the
 * `mcp.tool_call` stream (no registry, no per-plugin config — the universal
 * page is free for any plugin that ever made a call). For each plugin it
 * computes the universal boundary metrics (volume, p95 latency, error-rate,
 * last-seen) and best-effort joins cost from `session_cost`. A plugin that also
 * declares a view-manifest gets its specialized panels filled too; one with no
 * manifest gets the universal page only (graceful degradation).
 *
 * Properties: READ-ONLY and out-of-band (it only `query()`s the contract and
 * reads manifests). It never writes, never blocks the gateway, holds no
 * god-mode — exactly the least-privilege reader half of the loop.
 */

import type {
  DateRange,
  MetricSample,
  PanelData,
  TelemetryProvider,
  ViewManifest,
  ViewManifestSource,
} from "../skills-tuner/core/telemetry.js";
import { MCP_TOOL_CALL_STREAM } from "./tool-call.js";

export interface PluginSummary {
  plugin: string;
  /** Tool-call count over the window. */
  volume: number;
  /** Fraction of calls with status="error", 0..1. */
  errorRate: number;
  /** p95 of `duration_ms`; null when no calls. */
  p95LatencyMs: number | null;
  /** ISO-8601 of the most recent call; null when none. */
  lastSeen: string | null;
  /** Summed cost joined from `session_cost` where the plugin name appears in a
   *  cost row's `job` label; null when no attributable cost. */
  costUsd: number | null;
  /** True when the plugin declared a view-manifest (→ has a specialized page). */
  hasManifest: boolean;
}

export interface PluginPage {
  plugin: string;
  summary: PluginSummary;
  /** null → universal page only. */
  manifest: ViewManifest | null;
  /** Filled panels (empty when no manifest). */
  panels: PanelData[];
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))] ?? null;
}

interface PluginAgg {
  latencies: number[];
  errors: number;
  total: number;
  lastMs: number;
}

export class ObservabilityReader {
  private readonly telemetry: TelemetryProvider;
  private readonly manifests?: ViewManifestSource;

  constructor(opts: { telemetry: TelemetryProvider; manifests?: ViewManifestSource }) {
    this.telemetry = opts.telemetry;
    this.manifests = opts.manifests;
  }

  /** Every declared manifest (specialized pages), or [] when none. */
  manifestList(): ViewManifest[] {
    return this.manifests?.viewManifests() ?? [];
  }

  /** Auto-discovered plugins with their universal boundary metrics. */
  async plugins(range: DateRange): Promise<PluginSummary[]> {
    const samples = await this.telemetry.query(MCP_TOOL_CALL_STREAM, range);
    const manifestPlugins = new Set(this.manifestList().map((m) => m.plugin));

    const byPlugin = new Map<string, PluginAgg>();
    for (const s of samples) {
      const plugin = s.labels?.plugin ?? "";
      if (!plugin) continue;
      let agg = byPlugin.get(plugin);
      if (!agg) {
        agg = { latencies: [], errors: 0, total: 0, lastMs: 0 };
        byPlugin.set(plugin, agg);
      }
      agg.total += 1;
      agg.latencies.push(s.value);
      if (s.labels?.status === "error") agg.errors += 1;
      const t = s.ts.getTime();
      if (t > agg.lastMs) agg.lastMs = t;
    }
    // Plugins that declared a manifest but have no traffic yet still get a page.
    for (const p of manifestPlugins) {
      if (!byPlugin.has(p)) byPlugin.set(p, { latencies: [], errors: 0, total: 0, lastMs: 0 });
    }

    const cost = await this.costByPlugin(range, new Set(byPlugin.keys()));

    const summaries: PluginSummary[] = [];
    for (const [plugin, agg] of byPlugin) {
      summaries.push({
        plugin,
        volume: agg.total,
        errorRate: agg.total > 0 ? agg.errors / agg.total : 0,
        p95LatencyMs: p95(agg.latencies),
        lastSeen: agg.lastMs > 0 ? new Date(agg.lastMs).toISOString() : null,
        costUsd: cost.get(plugin) ?? null,
        hasManifest: manifestPlugins.has(plugin),
      });
    }
    summaries.sort((a, b) => b.volume - a.volume || a.plugin.localeCompare(b.plugin));
    return summaries;
  }

  /** A plugin's full page: universal summary + (if declared) manifest + panels. */
  async pageFor(plugin: string, range: DateRange): Promise<PluginPage> {
    const summaries = await this.plugins(range);
    const summary =
      summaries.find((s) => s.plugin === plugin) ??
      ({
        plugin,
        volume: 0,
        errorRate: 0,
        p95LatencyMs: null,
        lastSeen: null,
        costUsd: null,
        hasManifest: false,
      } satisfies PluginSummary);

    const manifest = this.manifestList().find((m) => m.plugin === plugin) ?? null;
    const panels: PanelData[] = [];
    if (manifest && this.manifests) {
      for (const panel of manifest.panels) {
        const data = await this.manifests.panelData(plugin, panel.id, range);
        if (data) panels.push(data);
      }
    }
    return { plugin, summary, manifest, panels };
  }

  /**
   * Best-effort cost attribution: `session_cost` carries a free-text `job`
   * label, not a plugin name, so we attribute a cost row to a plugin when the
   * plugin's name appears in `job`. Unmatched cost simply isn't attributed
   * (a plugin stays `costUsd: null`) — never guessed.
   */
  private async costByPlugin(range: DateRange, plugins: Set<string>): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (plugins.size === 0) return out;
    let samples: MetricSample[];
    try {
      samples = await this.telemetry.query("session_cost", range);
    } catch {
      return out;
    }
    const lowered = [...plugins]
      .map((p) => [p, p.toLowerCase()] as const)
      .filter(([, l]) => l !== "");
    for (const cs of samples) {
      const job = (cs.labels?.job ?? "").toLowerCase();
      if (!job) continue;
      for (const [plugin, low] of lowered) {
        if (job.includes(low)) out.set(plugin, (out.get(plugin) ?? 0) + cs.value);
      }
    }
    return out;
  }
}
