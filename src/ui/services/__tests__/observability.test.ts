import { afterEach, describe, expect, it } from "bun:test";
import { ObservabilityReader } from "../../../observability/reader.js";
import type {
  MetricSample,
  PanelData,
  TelemetryCapability,
  TelemetryProvider,
  TelemetryStream,
  ViewManifest,
  ViewManifestSource,
} from "../../../skills-tuner/core/telemetry.js";
import {
  __setObservabilityReaderForTest,
  getObservabilityOverview,
  getObservabilityPluginPage,
  resetObservabilityReader,
} from "../observability.js";

/** Serves canned mcp.tool_call samples — same shape as reader.test's fake. */
class FakeProvider implements TelemetryProvider {
  constructor(private readonly toolCalls: MetricSample[]) {}
  contractVersion(): string {
    return "1.1.0";
  }
  capabilities(): TelemetryCapability[] {
    return [];
  }
  async query(stream: TelemetryStream): Promise<MetricSample[]> {
    return stream === "mcp.tool_call" ? this.toolCalls : [];
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
    return {
      panelId,
      rows: [{ ts: "2026-05-25T01:00:00.000Z", subject: "cron", verdict: "improved" }],
    };
  }
}

function sample(plugin: string, status: string, durationMs: number, tsIso: string): MetricSample {
  return { ts: new Date(tsIso), value: durationMs, labels: { plugin, status, tool: "t" } };
}

const TUNER_MANIFEST: ViewManifest = {
  plugin: "tuner",
  schemaVersion: "1.0.0",
  panels: [{ id: "tuner.timeline", kind: "timeline", title: "Tuning proposals → outcomes" }],
};

function injectReader(): void {
  const reader = new ObservabilityReader({
    telemetry: new FakeProvider([
      sample("alpha", "ok", 10, "2026-05-25T01:00:00.000Z"),
      sample("alpha", "error", 40, "2026-05-25T02:00:00.000Z"),
      sample("tuner", "ok", 5, "2026-05-25T03:00:00.000Z"),
    ]),
    manifests: new FakeManifests([TUNER_MANIFEST]),
  });
  __setObservabilityReaderForTest(reader);
}

afterEach(() => {
  resetObservabilityReader();
});

describe("observability service — overview", () => {
  it("returns volume-sorted plugins, the specialized list, and echoes the window", async () => {
    injectReader();
    const overview = await getObservabilityOverview(72);
    expect(overview.rangeHours).toBe(72);
    expect(overview.plugins.map((p) => p.plugin)).toEqual(["alpha", "tuner"]);
    expect(overview.specializedPlugins).toEqual(["tuner"]);
    expect(overview.plugins.find((p) => p.plugin === "tuner")?.hasManifest).toBe(true);
    expect(typeof overview.generatedAt).toBe("string");
  });

  it("caches within the TTL: same window returns the identical object", async () => {
    injectReader();
    const a = await getObservabilityOverview(168);
    const b = await getObservabilityOverview(168);
    expect(b).toBe(a);
  });

  it("caches per window: a different window recomputes", async () => {
    injectReader();
    const a = await getObservabilityOverview(24);
    const b = await getObservabilityOverview(168);
    expect(b).not.toBe(a);
    expect(b.rangeHours).toBe(168);
  });
});

describe("observability service — plugin page", () => {
  it("fills the specialized panels for a plugin that declared a manifest", async () => {
    injectReader();
    const page = await getObservabilityPluginPage("tuner", 168);
    expect(page.manifest?.plugin).toBe("tuner");
    expect(page.panels).toHaveLength(1);
    expect(page.panels[0]?.panelId).toBe("tuner.timeline");
    expect(page.summary.hasManifest).toBe(true);
  });

  it("graceful degradation: a plugin with no manifest gets the universal page only", async () => {
    injectReader();
    const page = await getObservabilityPluginPage("alpha", 168);
    expect(page.manifest).toBeNull();
    expect(page.panels).toEqual([]);
    expect(page.summary.volume).toBe(2);
    expect(page.summary.errorRate).toBeCloseTo(0.5, 5);
  });
});
