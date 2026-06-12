import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronSubject } from "../../subjects/cron-subject.js";
import { WisecronStateDB } from "../../wisecron/state-db.js";
import { OutcomeRecorder } from "../../wisecron/outcome-loop.js";
import { Registry } from "../../../skills-tuner/core/registry.js";
import { AuditLog } from "../../../skills-tuner/core/audit-log.js";
import type { Proposal } from "../../../skills-tuner/core/types.js";
import type {
  DateRange,
  MetricSample,
  TelemetryProvider,
  TelemetryStream,
} from "../../../skills-tuner/core/telemetry.js";
import type { ScheduledJob, SchedulerBackend } from "../../../skills-tuner/schedulers/base.js";

/** Stub provider: scripted samples per stream. */
function stubProvider(
  streams: Partial<Record<TelemetryStream, MetricSample[]>>,
): TelemetryProvider {
  return {
    contractVersion: () => "1.0.0",
    capabilities: () =>
      (Object.keys(streams) as TelemetryStream[]).map((s) => ({
        stream: s,
        schemaVersion: "1.0.0",
        available: true,
      })),
    query: async (stream) => streams[stream] ?? [],
  };
}

function sample(value: number, job: string): MetricSample {
  return { ts: new Date("2026-05-20T00:00:00Z"), value, labels: { job, model: "opus" } };
}

/** Minimal scheduler exposing only list() (all this subject's fitness needs). */
function stubScheduler(jobs: Array<Pick<ScheduledJob, "name" | "status">>): SchedulerBackend {
  return {
    list: async () =>
      jobs.map((j) => ({
        name: j.name,
        schedule: "*-*-* *:00:00",
        command: "/bin/true",
        status: j.status,
        artifactPath: null,
      })),
  } as unknown as SchedulerBackend;
}

const RANGE: DateRange = {
  start: new Date("2026-05-13T00:00:00Z"),
  end: new Date("2026-05-20T00:00:00Z"),
};

describe("CronSubject.fitnessSignals", () => {
  it("declares cron_cost (session_cost, lower) guarded against Goodhart", () => {
    const sigs = new CronSubject().fitnessSignals();
    const cost = sigs.find((m) => m.name === "cron_cost")!;
    expect(cost.source).toBe("session_cost");
    expect(cost.direction).toBe("lower_is_better");
    expect(cost.guardrails).toContain("active_cron_count");
    expect(cost.guardrails).toContain("critical_fire_success");
    // active_cron_count is artifact (always activatable); critical_fire_success is a stream.
    expect(sigs.find((m) => m.name === "active_cron_count")!.source).toBe("artifact");
    expect(sigs.find((m) => m.name === "critical_fire_success")!.source).toBe("cron_run");
  });
});

describe("CronSubject.measureFitness", () => {
  it("attributes only cron-origin sessions and aggregates with a robust median", async () => {
    const provider = stubProvider({
      session_cost: [
        sample(2.0, '<channel source="cron" id=1>'),
        sample(4.0, '<channel source="cron" id=2>'),
        sample(6.0, '<channel source="cron" id=3>'),
        sample(500.0, "bootstrap"), // not cron-origin → excluded
        sample(0.5, "gmail"), // not cron-origin → excluded
      ],
    });
    const out = await new CronSubject().measureFitness(RANGE, provider);
    // median of [2,4,6] = 4 — the non-cron 500 outlier is excluded by attribution.
    expect(out.cron_cost).toBe(4.0);
  });

  it("median is robust: one huge cron outlier does not dominate", async () => {
    const provider = stubProvider({
      session_cost: [
        sample(1, "wisecron-foo"),
        sample(2, "wisecron-foo"),
        sample(3, "wisecron-foo"),
        sample(1000, "wisecron-foo"), // outlier
      ],
    });
    const out = await new CronSubject().measureFitness(RANGE, provider);
    // median of [1,2,3,1000] = 2.5 (a raw mean would be ~251.5).
    expect(out.cron_cost).toBe(2.5);
  });

  it("counts active scheduler units for active_cron_count (artifact guardrail)", async () => {
    const scheduler = stubScheduler([
      { name: "wisecron-a", status: "active" },
      { name: "wisecron-b", status: "active" },
      { name: "wisecron-c", status: "inactive" },
    ]);
    const out = await new CronSubject({ scheduler }).measureFitness(RANGE, stubProvider({}));
    expect(out.active_cron_count).toBe(2);
  });

  it("omits active_cron_count when no scheduler is wired (degrade gracefully)", async () => {
    const out = await new CronSubject().measureFitness(RANGE, stubProvider({}));
    expect("active_cron_count" in out).toBe(false);
  });

  it("omits cron_cost when no cron-origin sessions exist", async () => {
    const provider = stubProvider({ session_cost: [sample(9, "bootstrap"), sample(3, "gmail")] });
    const out = await new CronSubject().measureFitness(RANGE, provider);
    expect("cron_cost" in out).toBe(false);
  });

  it("derives critical_fire_success from cron_run when a producer exists", async () => {
    // value 0 = clean exit, nonzero = failure → success rate = 1 - nonzeroRate.
    const provider = stubProvider({
      cron_run: [sample(0, "u"), sample(0, "u"), sample(0, "u"), sample(1, "u")],
    });
    const out = await new CronSubject().measureFitness(RANGE, provider);
    expect(out.critical_fire_success).toBeCloseTo(0.75, 5);
  });

  it("omits critical_fire_success when cron_run has no producer", async () => {
    const out = await new CronSubject().measureFitness(RANGE, stubProvider({ session_cost: [] }));
    expect("critical_fire_success" in out).toBe(false);
  });

  it("reads cost ONLY via provider.query — never opens a store directly", async () => {
    const queried: TelemetryStream[] = [];
    const provider: TelemetryProvider = {
      contractVersion: () => "1.0.0",
      capabilities: () => [],
      query: async (stream) => {
        queried.push(stream);
        return stream === "session_cost" ? [sample(3, "wisecron-x")] : [];
      },
    };
    const out = await new CronSubject().measureFitness(RANGE, provider);
    expect(queried).toContain("session_cost");
    expect(out.cron_cost).toBe(3);
  });
});

/**
 * End-to-end through the real OutcomeRecorder: the real CronSubject drives
 * baseline → maturation → verdict against a provider that advertises only
 * session_cost (cron_run absent → critical_fire_success degrades to inactive).
 */
describe("CronSubject through OutcomeRecorder (baseline → maturation → verdict)", () => {
  let dir: string;
  let db: WisecronStateDB;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cron-outcome-"));
    db = new WisecronStateDB(join(dir, "wisecron.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function proposal(id: number): Proposal {
    return {
      id,
      cluster_id: `c-${id}`,
      subject: "cron",
      kind: "cron_change",
      target_path: "wisecron-demo.service",
      alternatives: [{ id: "a", label: "a", diff_or_content: "{}", tradeoff: "" }],
      pattern_signature: `cron:${id}`,
      created_at: new Date(),
      signature: "sig",
    };
  }

  /** Provider advertising only session_cost; cost shifts by measurement order. */
  function shiftingCostProvider(baselineCosts: number[], postCosts: number[]): TelemetryProvider {
    let call = 0;
    return {
      contractVersion: () => "1.0.0",
      capabilities: () => [{ stream: "session_cost", schemaVersion: "1.0.0", available: true }],
      query: async (stream) => {
        if (stream !== "session_cost") return []; // cron_run absent
        const costs = call === 0 ? baselineCosts : postCosts;
        call += 1;
        return costs.map((c) => sample(c, '<channel source="cron">'));
      },
    };
  }

  it("verdict=improved when cron_cost drops and active_cron_count holds", async () => {
    const registry = new Registry();
    const scheduler = stubScheduler([
      { name: "wisecron-a", status: "active" },
      { name: "wisecron-b", status: "active" },
    ]);
    registry.registerSubject(new CronSubject({ scheduler }));
    const provider = shiftingCostProvider([10, 10, 10], [6, 6, 6]);
    const audit = new AuditLog();
    let t = new Date("2026-05-01T00:00:00Z");
    const rec = new OutcomeRecorder(registry, db, provider, audit, () => t);

    await rec.snapshotBaseline(proposal(1), "sha-improve");
    // cron_cost (stream, advertised) + active_cron_count (artifact) snapshotted.
    // critical_fire_success is NOT snapshotted (cron_run unavailable).
    const rows = db.getOutcomes("1");
    expect(rows.map((r) => r.metric).sort()).toEqual(["active_cron_count", "cron_cost"]);
    expect(rows.find((r) => r.metric === "cron_cost")!.baseline).toBe(10);

    t = new Date("2026-05-10T00:00:00Z"); // past the 7d window
    const results = await rec.runMaturation({ revert: async () => false });
    expect(results).toHaveLength(1);
    expect(results[0]!.target_metric).toBe("cron_cost");
    expect(results[0]!.verdict).toBe("improved");
    const matured = db.getOutcomes("1").find((r) => r.metric === "cron_cost")!;
    expect(matured.post).toBe(6);
    expect(matured.delta).toBe(-4);
    expect(audit.verifyChain().ok).toBe(true);
  });

  it("verdict=regressed and HIGH-risk cron enqueues for human (no auto-revert)", async () => {
    const registry = new Registry();
    const scheduler = stubScheduler([{ name: "wisecron-a", status: "active" }]);
    registry.registerSubject(new CronSubject({ scheduler }));
    const provider = shiftingCostProvider([10, 10, 10], [18, 18, 18]); // cost rose → regressed
    const audit = new AuditLog();
    let t = new Date("2026-05-01T00:00:00Z");
    const rec = new OutcomeRecorder(registry, db, provider, audit, () => t);

    await rec.snapshotBaseline(proposal(2), "sha-regress");
    t = new Date("2026-05-10T00:00:00Z");
    const routed: string[] = [];
    const results = await rec.runMaturation({
      revert: async (_id, tier) => {
        routed.push(tier);
        return tier === "low"; // high → enqueued (false)
      },
    });
    expect(results[0]!.verdict).toBe("regressed");
    expect(routed).toEqual(["high"]);
    expect(results[0]!.reverted).toBe(false);
    expect(
      audit.all().some((r) => r.event === "revert" && r.actor === "system:enqueued-for-human"),
    ).toBe(true);
  });
});
