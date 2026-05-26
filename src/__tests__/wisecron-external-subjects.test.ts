import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapWisecron } from "../skills-tuner/cli/wisecron-bootstrap";
import { WisecronSettingsSchema } from "../tuner/wisecron/types";
import { ExternalProcessSubject } from "../skills-tuner/subjects/external_process";
import { NullTelemetryProvider } from "../skills-tuner/core/telemetry";

const tmps: string[] = [];
function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "wisecron-ext-"));
  tmps.push(dir);
  return join(dir, "wisecron.db");
}

afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOOP = [process.execPath, "-e", "process.stdout.write('{\"result\":[]}')"];

// Built-ins default to enabled (undefined !== false), so isolate the external
// path by explicitly disabling all eight wisecron subjects.
const BUILTINS = [
  "cron",
  "claude_md",
  "hook",
  "mcp_plugin",
  "model_routing",
  "prompt_template",
  "memory",
  "agent",
];
function disabledBuiltins(): Record<string, { enabled: boolean }> {
  return Object.fromEntries(BUILTINS.map((n) => [n, { enabled: false }]));
}

function settingsWith(external_subjects: unknown[]) {
  return WisecronSettingsSchema.parse({
    enabled: true,
    db_path: tmpDb(),
    subjects: disabledBuiltins(), // isolate the external path
    external_subjects,
  });
}

describe("wisecron external_subjects registration", () => {
  it("registers one ExternalProcessSubject per enabled config entry", () => {
    const settings = settingsWith([
      {
        name: "pattern_detector",
        command: NOOP,
        cwd: "/tmp",
        allowedRoots: ["/tmp/params"],
        riskTier: "high",
        autoMergeDefault: false,
        config: { params_path: "/tmp/params/p.json" },
        fitnessSignals: [
          {
            name: "bull_flag_conformity",
            source: "artifact",
            kind: "verifiable",
            direction: "higher_is_better",
            windowDays: 5,
          },
        ],
      },
    ]);

    const { registry } = bootstrapWisecron({
      settings,
      telemetry: new NullTelemetryProvider(),
      runHealthChecks: false,
    });

    const subj = registry.getSubject("pattern_detector");
    expect(subj).toBeInstanceOf(ExternalProcessSubject);
    expect(subj!.risk_tier).toBe("high");
    expect(subj!.auto_merge_default).toBe(false);
    // The statically-declared fitness metric is carried through from config.
    const signals = subj!.fitnessSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.name).toBe("bull_flag_conformity");
    expect(signals[0]!.source).toBe("artifact");
  });

  it("skips entries with enabled:false", () => {
    const settings = settingsWith([
      { name: "on", command: NOOP },
      { name: "off", command: NOOP, enabled: false },
    ]);
    const { registry } = bootstrapWisecron({
      settings,
      telemetry: new NullTelemetryProvider(),
      runHealthChecks: false,
    });
    expect(registry.getSubject("on")).toBeInstanceOf(ExternalProcessSubject);
    expect(registry.getSubject("off")).toBeUndefined();
  });

  it("registers none when external_subjects is absent (generic default)", () => {
    const settings = WisecronSettingsSchema.parse({
      enabled: true,
      db_path: tmpDb(),
      subjects: disabledBuiltins(),
    });
    const { registry } = bootstrapWisecron({
      settings,
      telemetry: new NullTelemetryProvider(),
      runHealthChecks: false,
    });
    expect(registry.allSubjects()).toHaveLength(0);
  });

  it("an external subject participates in the recorder's fitness path", async () => {
    // The recorder reads fitnessSignals() off whatever the registry holds; an
    // artifact-source metric is always active, so a registered external subject
    // is measurable end-to-end (measureFitness proxied to the subprocess).
    const settings = settingsWith([
      {
        name: "metric_echo",
        command: [
          process.execPath,
          "-e",
          'process.stdout.write(\'{"result":{"bull_flag_conformity":0.42}}\')',
        ],
        fitnessSignals: [
          {
            name: "bull_flag_conformity",
            source: "artifact",
            kind: "verifiable",
            direction: "higher_is_better",
            windowDays: 5,
          },
        ],
      },
    ]);
    const { registry } = bootstrapWisecron({
      settings,
      telemetry: new NullTelemetryProvider(),
      runHealthChecks: false,
    });
    const subj = registry.getSubject("metric_echo")!;
    const out = await subj.measureFitness(
      { start: new Date("2026-05-01"), end: new Date("2026-05-06") },
      new NullTelemetryProvider(),
    );
    expect(out.bull_flag_conformity).toBe(0.42);
  });
});
