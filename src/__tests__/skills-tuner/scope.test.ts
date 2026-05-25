import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillsSubject } from "../../skills-tuner/subjects/skills.js";
import { TunerConfigSchema, subjectScope } from "../../skills-tuner/core/config.js";
import {
  DEFAULT_SCOPE,
  ScopeResolver,
  ScopedTelemetryProvider,
  defaultAgentSurface,
  encodeProjectDir,
  isScope,
  resolveScope,
  sampleInAgentScope,
  SCOPE_FILTER_KEY,
  AGENT_SESSION_DIRS_FILTER_KEY,
} from "../../skills-tuner/core/scope.js";
import type {
  DateRange,
  MetricSample,
  TelemetryProvider,
  TelemetryStream,
} from "../../skills-tuner/core/telemetry.js";
import { TELEMETRY_CONTRACT_VERSION } from "../../skills-tuner/core/telemetry.js";

const RANGE: DateRange = { start: new Date("2026-05-01"), end: new Date("2026-05-08") };
const SURFACE = defaultAgentSurface("/home/tester"); // roots=[/home/tester/agent], jobMarkers include it

/** Records the filters it was handed, returns a fixed sample set per stream. */
class RecordingProvider implements TelemetryProvider {
  lastFilters?: Record<string, string>;
  constructor(private readonly byStream: Partial<Record<TelemetryStream, MetricSample[]>>) {}
  contractVersion() {
    return TELEMETRY_CONTRACT_VERSION;
  }
  capabilities() {
    return [];
  }
  async query(
    stream: TelemetryStream,
    _range: DateRange,
    filters?: Record<string, string>,
  ): Promise<MetricSample[]> {
    this.lastFilters = filters;
    return this.byStream[stream] ?? [];
  }
}

describe("resolveScope — per-subject ?? global ?? all", () => {
  it("defaults to all when nothing is set", () => {
    expect(resolveScope(undefined, undefined)).toBe("all");
    expect(DEFAULT_SCOPE).toBe("all");
  });
  it("uses the global scope when no per-subject override", () => {
    expect(resolveScope("agent", undefined)).toBe("agent");
    expect(resolveScope("all", undefined)).toBe("all");
  });
  it("per-subject override beats the global scope", () => {
    expect(resolveScope("all", "agent")).toBe("agent");
    expect(resolveScope("agent", "all")).toBe("all");
  });
  it("isScope guards bad input", () => {
    expect(isScope("agent")).toBe(true);
    expect(isScope("all")).toBe(true);
    expect(isScope("global")).toBe(false);
    expect(isScope(undefined)).toBe(false);
  });
});

describe("encodeProjectDir / defaultAgentSurface", () => {
  it("encodes a cwd the way Claude Code names project dirs", () => {
    expect(encodeProjectDir("/home/tester/agent")).toBe("-home-tester-agent");
  });
  it("agent surface is a strict subset rooted at ~/agent", () => {
    const s = defaultAgentSurface("/home/tester");
    expect(s.roots).toEqual(["/home/tester/agent"]);
    expect(s.skillsDirs).toEqual(["/home/tester/agent/skills"]);
    expect(s.sessionProjectDirs).toEqual(["-home-tester-agent"]);
    expect(s.jobMarkers).toContain("/home/tester/agent");
  });
});

describe("sampleInAgentScope — per-stream attribution", () => {
  it("keeps cost rows whose job label is agent-attributed, drops others", () => {
    const agent: MetricSample = { ts: RANGE.start, value: 3, labels: { job: 'source="cron"' } };
    const general: MetricSample = {
      ts: RANGE.start,
      value: 9,
      labels: { job: "interactive repl" },
    };
    expect(sampleInAgentScope("session_cost", agent, SURFACE)).toBe(true);
    expect(sampleInAgentScope("session_cost", general, SURFACE)).toBe(false);
  });
  it("keeps memory reads under an agent root, drops others", () => {
    const inAgent: MetricSample = {
      ts: RANGE.start,
      value: 1,
      labels: { file: "/home/tester/agent/learnings/x.md" },
    };
    const outside: MetricSample = {
      ts: RANGE.start,
      value: 1,
      labels: { file: "/home/tester/.claude/CLAUDE.md" },
    };
    expect(sampleInAgentScope("memory_access", inAgent, SURFACE)).toBe(true);
    expect(sampleInAgentScope("memory_access", outside, SURFACE)).toBe(false);
  });
  it("keeps session-derived + unattributable streams (documented pass-through)", () => {
    const s: MetricSample = { ts: RANGE.start, value: 0, labels: { tool: "Read" } };
    expect(sampleInAgentScope("tool_call", s, SURFACE)).toBe(true);
    expect(sampleInAgentScope("hook_exec", s, SURFACE)).toBe(true);
  });
});

describe("ScopedTelemetryProvider", () => {
  const costSamples: MetricSample[] = [
    { ts: RANGE.start, value: 3, labels: { job: 'source="cron"' } },
    { ts: RANGE.start, value: 9, labels: { job: "interactive repl" } },
    { ts: RANGE.start, value: 2, labels: { job: "/home/tester/agent/scripts/x.py" } },
  ];

  it("all scope is a pure pass-through (no filter injection, no narrowing)", async () => {
    const inner = new RecordingProvider({ session_cost: costSamples });
    const scoped = new ScopedTelemetryProvider(inner, "all", SURFACE);
    const out = await scoped.query("session_cost", RANGE, { job: "x" });
    expect(out).toHaveLength(3);
    expect(inner.lastFilters).toEqual({ job: "x" }); // forwarded verbatim, no scope keys
  });

  it("agent scope injects scope hints AND narrows to agent rows", async () => {
    const inner = new RecordingProvider({ session_cost: costSamples });
    const scoped = new ScopedTelemetryProvider(inner, "agent", SURFACE);
    const out = await scoped.query("session_cost", RANGE);
    // Only the two agent-attributed rows survive.
    expect(out.map((s) => s.value).sort()).toEqual([2, 3]);
    // Scope hints reach the inner provider so scope-aware producers self-restrict.
    expect(inner.lastFilters?.[SCOPE_FILTER_KEY]).toBe("agent");
    expect(inner.lastFilters?.[AGENT_SESSION_DIRS_FILTER_KEY]).toBe("-home-tester-agent");
  });

  it("agent scope query is strictly bounded vs all scope query", async () => {
    const inner = new RecordingProvider({ session_cost: costSamples });
    const all = await new ScopedTelemetryProvider(inner, "all", SURFACE).query(
      "session_cost",
      RANGE,
    );
    const agent = await new ScopedTelemetryProvider(inner, "agent", SURFACE).query(
      "session_cost",
      RANGE,
    );
    expect(agent.length).toBeLessThan(all.length);
  });

  it("delegates contractVersion + capabilities to the inner provider", () => {
    const inner = new RecordingProvider({});
    const scoped = new ScopedTelemetryProvider(inner, "agent", SURFACE);
    expect(scoped.contractVersion()).toBe(TELEMETRY_CONTRACT_VERSION);
    expect(scoped.capabilities()).toEqual([]);
  });
});

describe("ScopeResolver", () => {
  const resolver = new ScopeResolver("all", { cron: "agent" }, SURFACE);

  it("resolves effective scope with the override precedence", () => {
    expect(resolver.for("cron")).toBe("agent");
    expect(resolver.for("skills")).toBe("all");
  });

  it("scopedProvider returns identity for all-scoped subjects, a wrapper for agent", () => {
    const inner = new RecordingProvider({});
    expect(resolver.scopedProvider("skills", inner)).toBe(inner);
    expect(resolver.scopedProvider("cron", inner)).toBeInstanceOf(ScopedTelemetryProvider);
  });

  it("snapshot reports global + per-subject effective scope for the audit chain", () => {
    const snap = resolver.snapshot(["cron", "skills", "hook"]);
    expect(snap).toEqual({
      global: "all",
      per_subject: { cron: "agent", skills: "all", hook: "all" },
    });
  });
});

describe("config — subjectScope resolution", () => {
  it("global default is all; per-subject scope overrides it", () => {
    const cfg = TunerConfigSchema.parse({
      scope: "agent",
      subjects: { skills: { scope: "all" }, wisecron: {} },
    });
    expect(cfg.scope).toBe("agent");
    expect(subjectScope(cfg, "skills")).toBe("all"); // override
    expect(subjectScope(cfg, "wisecron")).toBe("agent"); // inherits global
    expect(subjectScope(cfg, "unknown")).toBe("agent"); // inherits global
  });

  it("defaults to all when scope is omitted entirely", () => {
    const cfg = TunerConfigSchema.parse({});
    expect(cfg.scope).toBe("all");
    expect(subjectScope(cfg, "skills")).toBe("all");
  });
});

describe("SkillsSubject — session scan bounded by scope", () => {
  let root: string;
  const skillsDir = () => join(root, "skills");
  const projectsDir = () => join(root, "projects");

  function writeSkill(): void {
    const dir = join(skillsDir(), "mytool");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: mytool\ntriggers: mytool\n---\n\n# mytool\n");
  }
  function writeSession(projectDir: string): void {
    const dir = join(projectsDir(), projectDir);
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: ts,
        message: { content: "please run mytool now" },
      }),
      JSON.stringify({ type: "user", timestamp: ts, message: { content: "nope that's wrong" } }),
    ];
    writeFileSync(join(dir, "s.jsonl"), `${lines.join("\n")}\n`);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skills-scope-"));
    writeSkill();
    writeSession("-home-agent"); // agent project dir
    writeSession("-home-general"); // general project dir
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const since = new Date(Date.now() - 7 * 86_400_000);

  it("all scope (no sessionProjectDirs) scans every project's sessions", async () => {
    const subj = new SkillsSubject({ scanDirs: [skillsDir()], projectsDir: projectsDir() });
    const obs = await subj.collectObservations(since);
    expect(obs.length).toBe(2); // one correction per project
  });

  it("agent scope restricts session scan to the agent's project dirs", async () => {
    const subj = new SkillsSubject({
      scanDirs: [skillsDir()],
      projectsDir: projectsDir(),
      sessionProjectDirs: ["-home-agent"],
    });
    const obs = await subj.collectObservations(since);
    expect(obs.length).toBe(1);
    expect(obs.length).toBeLessThan(2);
  });
});
