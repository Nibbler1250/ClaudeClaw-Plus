/**
 * OutcomeLoop fitness tests for the six producer-backed subjects (hook,
 * mcp_plugin, model_routing, prompt_template, memory, agent). Mirrors the
 * cron-fitness pattern: a stub provider scripts Tier 1 streams; temp fixtures
 * exercise the Tier 1b artifact scans + outlier-robustness + degrade-gracefully.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookSubject } from "../../subjects/hook-subject.js";
import { McpPluginSubject } from "../../subjects/mcp-plugin-subject.js";
import { ModelRoutingSubject } from "../../subjects/model-routing-subject.js";
import { PromptTemplateSubject } from "../../subjects/prompt-template-subject.js";
import { MemorySubject } from "../../subjects/memory-subject.js";
import { AgentSubject } from "../../subjects/agent-subject.js";
import { activateFitness } from "../../../skills-tuner/core/fitness.js";
import { AuditLog } from "../../../skills-tuner/core/audit-log.js";
import type {
  DateRange,
  MetricSample,
  TelemetryProvider,
  TelemetryStream,
} from "../../../skills-tuner/core/telemetry.js";

const RANGE: DateRange = {
  start: new Date("2026-05-13T00:00:00Z"),
  end: new Date("2026-05-20T00:00:00Z"),
};
const TS = new Date("2026-05-18T00:00:00Z");

/** Stub provider: scripted samples per stream; advertises each as available. */
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

const EMPTY = stubProvider({});

function s(value: number, labels: Record<string, string> = {}): MetricSample {
  return { ts: TS, value, labels };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fitness-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ── hook ─────────────────────────────────────────────────────────────────────

describe("HookSubject fitness", () => {
  it("declares hook_crash_rate (hook_exec, lower) guarded by hook_active_count", () => {
    const sigs = new HookSubject().fitnessSignals();
    const crash = sigs.find((m) => m.name === "hook_crash_rate")!;
    expect(crash.source).toBe("hook_exec");
    expect(crash.direction).toBe("lower_is_better");
    expect(crash.guardrails).toContain("hook_active_count");
    expect(sigs.find((m) => m.name === "hook_active_count")!.source).toBe("artifact");
    expect(sigs.find((m) => m.name === "hook_defect_count")!.source).toBe("artifact");
  });

  it("derives crash_rate + p95 from hook_exec and scans the hooks dir", async () => {
    writeFileSync(join(dir, "good.sh"), "#!/bin/sh\necho hi\n");
    writeFileSync(join(dir, "broken.sh"), "echo no shebang\n"); // defect
    const provider = stubProvider({
      hook_exec: [
        s(100, { exit_code: "0" }),
        s(200, { exit_code: "0" }),
        s(5000, { exit_code: "1" }), // crash + p95 outlier
        s(150, { exit_code: "0" }),
      ],
    });
    const out = await new HookSubject({ hooksDir: dir }).measureFitness(RANGE, provider);
    expect(out.hook_crash_rate).toBeCloseTo(0.25, 5);
    expect(out.hook_p95_duration_ms).toBe(5000);
    expect(out.hook_active_count).toBe(2);
    expect(out.hook_defect_count).toBe(1);
  });

  it("omits stream metrics when hook_exec has no producer (degrade)", async () => {
    writeFileSync(join(dir, "a.sh"), "#!/bin/sh\n");
    const out = await new HookSubject({ hooksDir: dir }).measureFitness(RANGE, EMPTY);
    expect("hook_crash_rate" in out).toBe(false);
    expect(out.hook_active_count).toBe(1);
  });
});

// ── mcp_plugin ─────────────────────────────────────────────────────────────--

describe("McpPluginSubject fitness", () => {
  it("declares mcp_tool_failure_rate (tool_call, lower) guarded by allowed_tool_count", () => {
    const sigs = new McpPluginSubject().fitnessSignals();
    const fail = sigs.find((m) => m.name === "mcp_tool_failure_rate")!;
    expect(fail.source).toBe("tool_call");
    expect(fail.guardrails).toContain("mcp_allowed_tool_count");
    expect(sigs.find((m) => m.name === "mcp_allowed_tool_count")!.source).toBe("artifact");
  });

  it("derives failure rate from tool_call and counts allowedTools defects", async () => {
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ allowedTools: ["a", "b", "a", ""] })); // dup a + empty
    const provider = stubProvider({ tool_call: [s(0), s(0), s(1), s(0)] }); // 1/4 failed
    const out = await new McpPluginSubject({ settingsPath: settings }).measureFitness(
      RANGE,
      provider,
    );
    expect(out.mcp_tool_failure_rate).toBeCloseTo(0.25, 5);
    expect(out.mcp_allowed_tool_count).toBe(4);
    expect(out.mcp_allowed_tool_defect_count).toBe(2); // one dup + one empty
  });

  it("measures an existing settings file with no allowedTools as {0,0}", async () => {
    const settings = join(dir, "settings.json");
    writeFileSync(settings, JSON.stringify({ other: 1 }));
    const out = await new McpPluginSubject({ settingsPath: settings }).measureFitness(RANGE, EMPTY);
    expect(out.mcp_allowed_tool_count).toBe(0);
    expect(out.mcp_allowed_tool_defect_count).toBe(0);
  });

  it("omits artifact metrics when settings file is absent (degrade)", async () => {
    const out = await new McpPluginSubject({ settingsPath: join(dir, "nope.json") }).measureFitness(
      RANGE,
      EMPTY,
    );
    expect("mcp_allowed_tool_count" in out).toBe(false);
  });
});

// ── model_routing ─────────────────────────────────────────────────────────--

describe("ModelRoutingSubject fitness", () => {
  it("declares routing_reclassify_rate (mode_dispatch, lower) guarded by active_mode_count", () => {
    const sigs = new ModelRoutingSubject().fitnessSignals();
    const r = sigs.find((m) => m.name === "routing_reclassify_rate")!;
    expect(r.source).toBe("mode_dispatch");
    expect(r.guardrails).toContain("routing_active_mode_count");
    expect(sigs.find((m) => m.name === "routing_duplicate_keyword_count")!.source).toBe("artifact");
  });

  it("derives reclassify rate from mode_dispatch and counts duplicate keywords", async () => {
    const cfg = join(dir, "agentic.yaml");
    writeFileSync(cfg, "modes:\n  a:\n    keywords: [x, y]\n  b:\n    keywords: [y, z]\n");
    const provider = stubProvider({ mode_dispatch: [s(0), s(1), s(0), s(0)] }); // 1/4 reclassified
    const out = await new ModelRoutingSubject({ modesConfigPath: cfg }).measureFitness(
      RANGE,
      provider,
    );
    expect(out.routing_reclassify_rate).toBeCloseTo(0.25, 5);
    expect(out.routing_active_mode_count).toBe(2);
    expect(out.routing_duplicate_keyword_count).toBe(1); // 'y' in both modes
  });

  it("omits all metrics when the modes config is absent (degrade)", async () => {
    const out = await new ModelRoutingSubject({
      modesConfigPath: join(dir, "nope.yaml"),
    }).measureFitness(RANGE, EMPTY);
    expect(Object.keys(out)).toHaveLength(0);
  });
});

// ── prompt_template ───────────────────────────────────────────────────────--

describe("PromptTemplateSubject fitness", () => {
  it("declares template_avg_rating (template_feedback, higher) guarded by template_count", () => {
    const sigs = new PromptTemplateSubject().fitnessSignals();
    const r = sigs.find((m) => m.name === "template_avg_rating")!;
    expect(r.source).toBe("template_feedback");
    expect(r.direction).toBe("higher_is_better");
    expect(r.guardrails).toContain("template_count");
  });

  it("aggregates ratings with a robust median and counts empty templates", async () => {
    const tdir = join(dir, "templates");
    mkdirSync(tdir);
    writeFileSync(join(tdir, "a.md"), "content");
    writeFileSync(join(tdir, "b.md"), "   "); // empty → defect
    // ratings: one huge outlier must not move the median.
    const provider = stubProvider({ template_feedback: [s(4), s(4), s(5), s(100)] });
    const out = await new PromptTemplateSubject({ templatesDir: tdir }).measureFitness(
      RANGE,
      provider,
    );
    expect(out.template_avg_rating).toBe(4.5); // median([4,4,5,100]) = 4.5
    expect(out.template_count).toBe(2);
    expect(out.template_defect_count).toBe(1);
  });

  it("omits artifact metrics when the templates dir is absent (degrade)", async () => {
    const out = await new PromptTemplateSubject({ templatesDir: join(dir, "nope") }).measureFitness(
      RANGE,
      EMPTY,
    );
    expect("template_count" in out).toBe(false);
  });
});

// ── memory ─────────────────────────────────────────────────────────────────--

describe("MemorySubject fitness", () => {
  it("declares memory_median_reads_per_entry (memory_access, higher) guarded by entry_count", () => {
    const sigs = new MemorySubject().fitnessSignals();
    const r = sigs.find((m) => m.name === "memory_median_reads_per_entry")!;
    expect(r.source).toBe("memory_access");
    expect(r.guardrails).toContain("memory_index_entry_count");
    expect(sigs.find((m) => m.name === "memory_index_defect_count")!.source).toBe("artifact");
  });

  it("scans dead-ref + duplicate-slug defects and median per-entry reads", async () => {
    const mdir = join(dir, "memory");
    mkdirSync(mdir);
    const index = join(mdir, "MEMORY.md");
    writeFileSync(index, "# Memory Index\n\n- [A](a.md) — x\n- [B](b.md) — y\n- [A2](a.md) — z\n");
    writeFileSync(join(mdir, "a.md"), "x"); // a.md exists; b.md missing
    // per-file read counts: f1 x1, f2 x1, f3 x1, hot x100 → median([1,1,1,100]) = 1.
    const provider = stubProvider({
      memory_access: [
        s(1, { file: "f1" }),
        s(1, { file: "f2" }),
        s(1, { file: "f3" }),
        ...Array.from({ length: 100 }, () => s(1, { file: "hot" })),
      ],
    });
    const out = await new MemorySubject({ memoryIndex: index }).measureFitness(RANGE, provider);
    expect(out.memory_index_entry_count).toBe(3);
    expect(out.memory_index_defect_count).toBe(3); // dup a (x2) + dead b
    expect(out.memory_median_reads_per_entry).toBe(1); // robust to the hot file
  });

  it("omits artifact metrics when the index is absent (degrade)", async () => {
    const out = await new MemorySubject({ memoryIndex: join(dir, "nope.md") }).measureFitness(
      RANGE,
      EMPTY,
    );
    expect("memory_index_entry_count" in out).toBe(false);
  });
});

// ── agent ──────────────────────────────────────────────────────────────────--

describe("AgentSubject fitness", () => {
  it("declares agent_reclassify_rate (agent_dispatch, lower) guarded by active_agent_count", () => {
    const sigs = new AgentSubject().fitnessSignals();
    const r = sigs.find((m) => m.name === "agent_reclassify_rate")!;
    expect(r.source).toBe("agent_dispatch");
    expect(r.guardrails).toContain("active_agent_count");
    expect(sigs.find((m) => m.name === "agent_desc_defect_count")!.source).toBe("artifact");
  });

  it("derives reclassify rate from agent_dispatch and counts description defects", async () => {
    const adir = join(dir, "agents");
    mkdirSync(adir);
    writeFileSync(
      join(adir, "good.md"),
      "---\nname: good\ndescription: A sufficiently long valid description here.\n---\nbody\n",
    );
    writeFileSync(join(adir, "short.md"), "---\nname: short\ndescription: too short\n---\nbody\n"); // < 30 chars
    const provider = stubProvider({ agent_dispatch: [s(0), s(0), s(1), s(0)] });
    const out = await new AgentSubject({ agentsDir: adir }).measureFitness(RANGE, provider);
    expect(out.agent_reclassify_rate).toBeCloseTo(0.25, 5);
    expect(out.active_agent_count).toBe(2);
    expect(out.agent_desc_defect_count).toBe(1);
  });

  it("omits artifact metrics when the agents dir is absent (degrade)", async () => {
    const out = await new AgentSubject({ agentsDir: join(dir, "nope") }).measureFitness(
      RANGE,
      EMPTY,
    );
    expect("active_agent_count" in out).toBe(false);
  });
});

// ── activation gate (the contract intersection) ──────────────────────────────

describe("activation gate across all six subjects", () => {
  it("activates artifact metrics always + stream metrics only when advertised", () => {
    const subjects = [
      new HookSubject({ hooksDir: dir }),
      new McpPluginSubject({ settingsPath: join(dir, "s.json") }),
      new ModelRoutingSubject({ modesConfigPath: join(dir, "m.yaml") }),
      new PromptTemplateSubject({ templatesDir: join(dir, "t") }),
      new MemorySubject({ memoryIndex: join(dir, "M.md") }),
      new AgentSubject({ agentsDir: join(dir, "a") }),
    ];
    // Host advertises hook_exec only; every other stream is unavailable.
    const provider: TelemetryProvider = {
      contractVersion: () => "1.0.0",
      capabilities: () => [
        { stream: "hook_exec", schemaVersion: "1.0.0", available: true },
        { stream: "tool_call", schemaVersion: "1.0.0", available: false, reason: "no producer" },
      ],
      query: async () => [],
    };
    const audit = new AuditLog();
    const { active, inactive } = activateFitness(subjects, provider, audit);

    // All artifact metrics are active.
    const activeNames = active.map((a) => a.metric.name);
    expect(activeNames).toContain("hook_active_count"); // artifact
    expect(activeNames).toContain("hook_crash_rate"); // hook_exec advertised
    expect(activeNames).toContain("memory_index_defect_count"); // artifact

    // tool_call advertised-but-unavailable → inactive with the host's reason.
    const failInactive = inactive.find((i) => i.metric.name === "mcp_tool_failure_rate")!;
    expect(failInactive.reason).toMatch(/no producer/);
    // agent_dispatch not advertised at all → inactive (host doesn't advertise).
    expect(inactive.some((i) => i.metric.name === "agent_reclassify_rate")).toBe(true);
    expect(audit.verifyChain().ok).toBe(true);
  });
});
