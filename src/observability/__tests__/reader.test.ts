import { describe, it, expect } from "bun:test";
import type {
  DateRange,
  MetricSample,
  PanelData,
  TelemetryCapability,
  TelemetryProvider,
  TelemetryStream,
  ViewManifest,
  ViewManifestSource,
} from "../../skills-tuner/core/telemetry.js";
import { ObservabilityReader } from "../reader.js";

const RANGE: DateRange = {
  start: new Date("2026-05-25T00:00:00.000Z"),
  end: new Date("2026-05-26T00:00:00.000Z"),
};

function sample(plugin: string, status: string, durationMs: number, tsIso: string): MetricSample {
  return { ts: new Date(tsIso), value: durationMs, labels: { plugin, status, tool: "t" } };
}

/** A telemetry provider serving canned mcp.tool_call + session_cost streams. */
class FakeProvider implements TelemetryProvider {
  constructor(
    private readonly toolCalls: MetricSample[],
    private readonly costs: MetricSample[] = [],
  ) {}
  contractVersion(): string {
    return "1.1.0";
  }
  capabilities(): TelemetryCapability[] {
    return [];
  }
  async query(stream: TelemetryStream): Promise<MetricSample[]> {
    if (stream === "mcp.tool_call") return this.toolCalls;
    if (stream === "session_cost") return this.costs;
    return [];
  }
}

class FakeManifests implements ViewManifestSource {
  constructor(private readonly manifests: ViewManifest[]) {}
  viewManifests(): ViewManifest[] {
    return this.manifests;
  }
  async panelData(plugin: string, panelId: string): Promise<PanelData | undefined> {
    const m = this.manifests.find((x) => x.plugin === plugin);
    if (!m || !m.panels.some((p) => p.id === panelId)) return undefined;
    return { panelId, rows: [{ hello: "world", plugin }] };
  }
}

describe("ObservabilityReader — auto-discovery + universal metrics", () => {
  it("discovers plugins from the mcp.tool_call stream and computes boundary metrics", async () => {
    const reader = new ObservabilityReader({
      telemetry: new FakeProvider([
        sample("alpha", "ok", 10, "2026-05-25T01:00:00.000Z"),
        sample("alpha", "ok", 30, "2026-05-25T02:00:00.000Z"),
        sample("alpha", "error", 50, "2026-05-25T03:00:00.000Z"),
        sample("beta", "ok", 5, "2026-05-25T04:00:00.000Z"),
      ]),
    });
    const plugins = await reader.plugins(RANGE);
    expect(plugins.map((p) => p.plugin)).toEqual(["alpha", "beta"]); // sorted by volume desc

    const alpha = plugins.find((p) => p.plugin === "alpha")!;
    expect(alpha.volume).toBe(3);
    expect(alpha.errorRate).toBeCloseTo(1 / 3, 5);
    expect(alpha.p95LatencyMs).toBe(50);
    expect(alpha.lastSeen).toBe("2026-05-25T03:00:00.000Z");
    expect(alpha.hasManifest).toBe(false);
    expect(alpha.costUsd).toBeNull();
  });

  it("joins cost from session_cost where the plugin name appears in the job label", async () => {
    const reader = new ObservabilityReader({
      telemetry: new FakeProvider(
        [sample("archiviste", "ok", 10, "2026-05-25T01:00:00.000Z")],
        [
          {
            ts: new Date("2026-05-25T01:00:00.000Z"),
            value: 0.4,
            labels: { job: "archiviste nightly", model: "haiku" },
          },
          {
            ts: new Date("2026-05-25T02:00:00.000Z"),
            value: 0.1,
            labels: { job: "unrelated cron", model: "haiku" },
          },
        ],
      ),
    });
    const plugins = await reader.plugins(RANGE);
    expect(plugins.find((p) => p.plugin === "archiviste")!.costUsd).toBeCloseTo(0.4, 5);
  });

  it("empty stream → no plugins discovered", async () => {
    const reader = new ObservabilityReader({ telemetry: new FakeProvider([]) });
    expect(await reader.plugins(RANGE)).toEqual([]);
  });
});

describe("ObservabilityReader — view-manifest pages", () => {
  const tunerManifest: ViewManifest = {
    plugin: "tuner",
    schemaVersion: "1.0.0",
    panels: [{ id: "tuner.timeline", kind: "timeline", title: "T" }],
  };

  it("graceful degradation: a plugin with no manifest gets the universal page only", async () => {
    const reader = new ObservabilityReader({
      telemetry: new FakeProvider([sample("alpha", "ok", 10, "2026-05-25T01:00:00.000Z")]),
      manifests: new FakeManifests([tunerManifest]),
    });
    const page = await reader.pageFor("alpha", RANGE);
    expect(page.manifest).toBeNull();
    expect(page.panels).toEqual([]);
    expect(page.summary.volume).toBe(1);
    expect(page.summary.hasManifest).toBe(false);
  });

  it("a plugin that declared a manifest gets its specialized panels filled", async () => {
    const reader = new ObservabilityReader({
      telemetry: new FakeProvider([sample("tuner", "ok", 10, "2026-05-25T01:00:00.000Z")]),
      manifests: new FakeManifests([tunerManifest]),
    });
    const page = await reader.pageFor("tuner", RANGE);
    expect(page.manifest?.plugin).toBe("tuner");
    expect(page.panels).toHaveLength(1);
    expect(page.panels[0]!.panelId).toBe("tuner.timeline");
    expect(page.summary.hasManifest).toBe(true);
  });

  it("a manifest-only plugin (declared, no traffic yet) still appears with a page", async () => {
    const reader = new ObservabilityReader({
      telemetry: new FakeProvider([]),
      manifests: new FakeManifests([tunerManifest]),
    });
    const plugins = await reader.plugins(RANGE);
    const tuner = plugins.find((p) => p.plugin === "tuner")!;
    expect(tuner.volume).toBe(0);
    expect(tuner.hasManifest).toBe(true);
    expect(tuner.p95LatencyMs).toBeNull();
  });
});
