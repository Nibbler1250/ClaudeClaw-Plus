import { describe, it, expect } from "bun:test";
import { TunableSubject } from "../../skills-tuner/core/interfaces.js";
import {
  activateFitness,
  isMetricActive,
  deriveCapabilitiesFromHealthChecks,
} from "../../skills-tuner/core/fitness.js";
import { AuditLog } from "../../skills-tuner/core/audit-log.js";
import type {
  Cluster,
  Observation,
  Patch,
  Proposal,
  UnsignedProposal,
  ValidationResult,
} from "../../skills-tuner/core/types.js";
import type {
  Metric,
  TelemetryCapability,
  TelemetryProvider,
} from "../../skills-tuner/core/telemetry.js";
import { TELEMETRY_CONTRACT_VERSION } from "../../skills-tuner/core/telemetry.js";

class FakeSubject extends TunableSubject {
  constructor(
    readonly name: string,
    private readonly metrics: Metric[],
    health?: { producer_found: boolean; sample_event_match_rate: number; reason?: string },
  ) {
    super();
    if (health) this.healthCheck = async () => health;
  }
  override fitnessSignals(): Metric[] {
    return this.metrics;
  }
  async collectObservations(): Promise<Observation[]> {
    return [];
  }
  async detectProblems(): Promise<Cluster[]> {
    return [];
  }
  async proposeChange(): Promise<UnsignedProposal> {
    throw new Error("n/a");
  }
  async apply(): Promise<Patch> {
    throw new Error("n/a");
  }
  async validate(): Promise<ValidationResult> {
    return { valid: true };
  }
}

class FakeProvider implements TelemetryProvider {
  constructor(private readonly caps: TelemetryCapability[]) {}
  contractVersion() {
    return TELEMETRY_CONTRACT_VERSION;
  }
  capabilities() {
    return this.caps;
  }
  async query() {
    return [];
  }
}

const artifact: Metric = {
  name: "broken_import_count",
  source: "artifact",
  kind: "verifiable",
  direction: "lower_is_better",
  windowDays: 1,
};
const costStream: Metric = {
  name: "cron_cost",
  source: "session_cost",
  kind: "verifiable",
  direction: "lower_is_better",
  windowDays: 7,
};
const judge: Metric = {
  name: "route_correctness",
  source: "mode_dispatch",
  kind: "judge",
  direction: "higher_is_better",
  windowDays: 7,
};

describe("activation gate", () => {
  it("artifact (Tier 1b) metrics always activate, even with no streams", () => {
    const audit = new AuditLog();
    const r = activateFitness(
      [new FakeSubject("claude_md", [artifact])],
      new FakeProvider([]),
      audit,
    );
    expect(r.active.map((a) => a.metric.name)).toEqual(["broken_import_count"]);
    expect(r.inactive).toEqual([]);
    expect(audit.all()[0]!.event).toBe("fitness_active");
  });

  it("stream metric inactivates when host does not advertise the stream", () => {
    const audit = new AuditLog();
    const r = activateFitness([new FakeSubject("cron", [costStream])], new FakeProvider([]), audit);
    expect(r.active).toEqual([]);
    expect(r.inactive[0]!.reason).toMatch(/does not advertise stream 'session_cost'/);
    expect(audit.all()[0]!.event).toBe("fitness_inactive");
  });

  it("stream metric activates when host advertises an available stream", () => {
    const audit = new AuditLog();
    const caps: TelemetryCapability[] = [
      { stream: "session_cost", schemaVersion: "1.0.0", available: true },
    ];
    const r = activateFitness(
      [new FakeSubject("cron", [costStream])],
      new FakeProvider(caps),
      audit,
    );
    expect(r.active.map((a) => a.metric.name)).toEqual(["cron_cost"]);
  });

  it("advertised-but-unavailable stream stays inactive with reason", () => {
    const caps: TelemetryCapability[] = [
      {
        stream: "session_cost",
        schemaVersion: "1.0.0",
        available: false,
        reason: "cost store empty",
      },
    ];
    const r = isMetricActive(costStream, new FakeProvider(caps));
    expect(r.active).toBe(false);
    expect(r.reason).toMatch(/cost store empty/);
  });

  it("judge (Tier 2) metrics never activate in Phase 1", () => {
    const audit = new AuditLog();
    const caps: TelemetryCapability[] = [
      { stream: "mode_dispatch", schemaVersion: "1.0.0", available: true },
    ];
    const r = activateFitness(
      [new FakeSubject("model_routing", [judge])],
      new FakeProvider(caps),
      audit,
    );
    expect(r.active).toEqual([]);
    expect(r.inactive[0]!.reason).toMatch(/deferred past Phase 1/);
  });
});

describe("fold: deriveCapabilitiesFromHealthChecks", () => {
  it("maps producer_found into stream availability with reason", async () => {
    const subjects = [
      new FakeSubject("cron", [costStream], {
        producer_found: false,
        sample_event_match_rate: 0,
        reason: "no wisecron units",
      }),
      new FakeSubject("hook", [], { producer_found: true, sample_event_match_rate: 0.9 }),
    ];
    const caps = await deriveCapabilitiesFromHealthChecks(subjects, {
      cron: "cron_run",
      hook: "hook_exec",
    });
    const cron = caps.find((c) => c.stream === "cron_run")!;
    const hook = caps.find((c) => c.stream === "hook_exec")!;
    expect(cron.available).toBe(false);
    expect(cron.reason).toMatch(/no wisecron units/);
    expect(hook.available).toBe(true);
  });
});
