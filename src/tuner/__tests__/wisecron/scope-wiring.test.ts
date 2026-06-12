import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWisecronSubjects } from "../../wisecron/index.js";
import { OutcomeRecorder } from "../../wisecron/outcome-loop.js";
import { SessionJsonlTelemetryProducer } from "../../wisecron/session-jsonl-provider.js";
import { WisecronStateDB } from "../../wisecron/state-db.js";
import { WisecronSettingsSchema } from "../../wisecron/types.js";
import { Registry } from "../../../skills-tuner/core/registry.js";
import { AuditLog } from "../../../skills-tuner/core/audit-log.js";
import {
  ScopeResolver,
  ScopedTelemetryProvider,
  defaultAgentSurface,
} from "../../../skills-tuner/core/scope.js";
import { TunableSubject, type RiskTier } from "../../../skills-tuner/core/interfaces.js";
import type {
  Cluster,
  Observation,
  Patch,
  Proposal,
  UnsignedProposal,
  ValidationResult,
} from "../../../skills-tuner/core/types.js";
import type {
  DateRange,
  Metric,
  MetricSample,
  TelemetryCapability,
  TelemetryProvider,
  TelemetryStream,
} from "../../../skills-tuner/core/telemetry.js";

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "scope-wiring-"));
  // Silence the boot health/fitness logs.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── registration audit + returned resolver ───────────────────────────────────

describe("registerWisecronSubjects — scope provenance", () => {
  it("records the active global + per-subject scope in the audit chain", () => {
    const registry = new Registry();
    const audit = new AuditLog(); // in-memory
    const settings = WisecronSettingsSchema.parse({
      enabled: true,
      scope: "agent",
      db_path: join(tmpDir, "wisecron.db"),
      subjects: { cron: { enabled: true, scope: "all" } },
    });
    const ctx = registerWisecronSubjects(registry, settings, {
      audit,
      runHealthChecks: false,
    });

    const rec = audit.all().find((r) => r.event === "scope_registration");
    expect(rec).toBeDefined();
    const detail = rec!.detail as { global: string; per_subject: Record<string, string> };
    expect(detail.global).toBe("agent");
    // cron overridden to all; a non-overridden subject inherits the global agent.
    expect(detail.per_subject["cron"]).toBe("all");
    expect(detail.per_subject["memory"]).toBe("agent");
    // The chain stays verifiable after the new record.
    expect(audit.verifyChain().ok).toBe(true);
  });

  it("returns a ScopeResolver reflecting the override precedence", () => {
    const registry = new Registry();
    const settings = WisecronSettingsSchema.parse({
      enabled: true,
      scope: "agent",
      db_path: join(tmpDir, "wisecron.db"),
      subjects: { cron: { enabled: true, scope: "all" } },
    });
    const ctx = registerWisecronSubjects(registry, settings, { runHealthChecks: false });
    expect(ctx.scopeResolver).toBeInstanceOf(ScopeResolver);
    expect(ctx.scopeResolver.for("cron")).toBe("all");
    expect(ctx.scopeResolver.for("hook")).toBe("agent");
  });

  it("defaults global scope to all when unset", () => {
    const registry = new Registry();
    const settings = WisecronSettingsSchema.parse({
      enabled: true,
      db_path: join(tmpDir, "wisecron.db"),
    });
    const ctx = registerWisecronSubjects(registry, settings, { runHealthChecks: false });
    expect(ctx.scopeResolver.for("cron")).toBe("all");
  });
});

// ── OutcomeRecorder hands subjects a scope-bounded provider ───────────────────

const COST_SAMPLES: MetricSample[] = [
  { ts: new Date("2026-05-02"), value: 3, labels: { job: 'source="cron"' } },
  { ts: new Date("2026-05-02"), value: 9, labels: { job: "interactive repl" } },
  { ts: new Date("2026-05-02"), value: 2, labels: { job: "/home/tester/agent/x.py" } },
];

class CostProvider implements TelemetryProvider {
  contractVersion() {
    return "1.0.0";
  }
  capabilities(): TelemetryCapability[] {
    return [{ stream: "session_cost", schemaVersion: "1.0.0", available: true }];
  }
  async query(stream: TelemetryStream): Promise<MetricSample[]> {
    return stream === "session_cost" ? COST_SAMPLES : [];
  }
}

/** Sums whatever session_cost rows the (possibly scoped) provider returns. */
class CostSubject extends TunableSubject {
  receivedScoped = false;
  constructor(
    readonly name: string,
    readonly risk_tier: RiskTier,
  ) {
    super();
  }
  override fitnessSignals(): Metric[] {
    return [
      {
        name: "cron_cost",
        source: "session_cost",
        kind: "verifiable",
        direction: "lower_is_better",
        windowDays: 7,
      },
    ];
  }
  override async measureFitness(
    range: DateRange,
    provider: TelemetryProvider,
  ): Promise<Record<string, number>> {
    this.receivedScoped = provider instanceof ScopedTelemetryProvider;
    const s = await provider.query("session_cost", range);
    if (s.length === 0) return {};
    return { cron_cost: s.reduce((a, b) => a + b.value, 0) };
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

function proposal(subject: string): Proposal {
  return {
    id: 1,
    cluster_id: "c-1",
    subject,
    kind: "patch",
    target_path: `/tmp/${subject}`,
    alternatives: [{ id: "a", label: "a", diff_or_content: "x", tradeoff: "" }],
    pattern_signature: `${subject}:1`,
    created_at: new Date(),
    signature: "sig",
  };
}

describe("OutcomeRecorder — scope-bounded measurement", () => {
  const surface = defaultAgentSurface("/home/tester");

  it("agent scope narrows the baseline to agent-attributed rows; all sees everything", async () => {
    const allRegistry = new Registry();
    const allSubj = new CostSubject("cron", "high");
    allRegistry.registerSubject(allSubj);
    const allDb = new WisecronStateDB(join(tmpDir, "all.db"));
    const allRec = new OutcomeRecorder(
      allRegistry,
      allDb,
      new CostProvider(),
      new AuditLog(),
      () => new Date("2026-05-08"),
      new ScopeResolver("all", {}, surface),
    );
    await allRec.snapshotBaseline(proposal("cron"));
    const allRow = allDb.getOutcomes("1").find((r) => r.metric === "cron_cost");
    allDb.close();
    expect(allSubj.receivedScoped).toBe(false);
    expect(allRow?.baseline).toBe(14); // 3 + 9 + 2

    const agentRegistry = new Registry();
    const agentSubj = new CostSubject("cron", "high");
    agentRegistry.registerSubject(agentSubj);
    const agentDb = new WisecronStateDB(join(tmpDir, "agent.db"));
    const agentRec = new OutcomeRecorder(
      agentRegistry,
      agentDb,
      new CostProvider(),
      new AuditLog(),
      () => new Date("2026-05-08"),
      new ScopeResolver("agent", {}, surface),
    );
    await agentRec.snapshotBaseline(proposal("cron"));
    const agentRow = agentDb.getOutcomes("1").find((r) => r.metric === "cron_cost");
    agentDb.close();
    expect(agentSubj.receivedScoped).toBe(true);
    expect(agentRow?.baseline).toBe(5); // only 3 + 2 (general 9 dropped)
  });
});

// ── SessionJsonl producer honors the agent-session-dir filter ─────────────────

describe("SessionJsonlTelemetryProducer — agent-session-dir scoping", () => {
  function writeSession(projectDir: string): void {
    const dir = join(tmpDir, "projects", projectDir);
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
    });
    writeFileSync(join(dir, "s.jsonl"), `${line}\n`);
  }

  it("scans only agent project dirs when handed the agent-session-dir filter", async () => {
    writeSession("-home-tester-agent"); // agent surface
    writeSession("-home-tester"); // general surface
    const producer = new SessionJsonlTelemetryProducer({
      projectsDir: join(tmpDir, "projects"),
    });
    const range: DateRange = {
      start: new Date(Date.now() - 7 * 86_400_000),
      end: new Date(Date.now() + 86_400_000),
    };

    const all = await producer.query("tool_call", range);
    const agent = await producer.query("tool_call", range, {
      __agent_session_dirs: "-home-tester-agent",
    });

    expect(all.length).toBe(2);
    expect(agent.length).toBe(1);
    expect(agent.length).toBeLessThan(all.length);
  });
});
