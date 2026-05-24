import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CronRunTelemetryProducer,
  HookExecTelemetryProducer,
  SkillAccessTelemetryProducer,
  JournalTelemetryProducer,
  CompositeTelemetryProvider,
  buildHostTelemetryProvider,
} from "../../wisecron/host-telemetry-provider.js";
import type {
  DateRange,
  MetricSample,
  TelemetryProvider,
  TelemetryStream,
} from "../../../skills-tuner/core/telemetry.js";
import { TELEMETRY_STREAMS } from "../../../skills-tuner/core/telemetry.js";

const RANGE: DateRange = {
  start: new Date("2026-05-13T00:00:00Z"),
  end: new Date("2026-05-21T00:00:00Z"),
};
const IN = new Date("2026-05-20T12:00:00Z");
const OUT = new Date("2026-06-10T12:00:00Z");

/** Build a journalctl JSON line as `journalctl --output json` would emit. */
function journalLine(opts: { unit: string; ts: Date; exit?: number | null }): string {
  const obj: Record<string, unknown> = {
    _SYSTEMD_USER_UNIT: opts.unit,
    __REALTIME_TIMESTAMP: String(opts.ts.getTime() * 1000),
    MESSAGE: "ran",
  };
  if (opts.exit !== null && opts.exit !== undefined) obj.EXIT_STATUS = String(opts.exit);
  return JSON.stringify(obj);
}

describe("CronRunTelemetryProducer", () => {
  it("emits cron_run samples with value=exit_code and status label", async () => {
    const raw = [
      journalLine({ unit: "wisecron-a.service", ts: IN, exit: 0 }),
      journalLine({ unit: "wisecron-b.service", ts: IN, exit: 1 }),
      journalLine({ unit: "wisecron-a.service", ts: IN, exit: null }), // no EXIT_STATUS → ignored
      journalLine({ unit: "wisecron-c.service", ts: OUT, exit: 0 }), // out of window
    ].join("\n");
    const p = new CronRunTelemetryProducer({ journalRunner: () => raw });
    const samples = await p.query("cron_run", RANGE);
    expect(samples).toHaveLength(2);
    expect(samples[0]!.value).toBe(0);
    expect(samples[0]!.labels).toEqual({
      unit: "wisecron-a.service",
      exit_code: "0",
      status: "success",
    });
    expect(samples[1]!.labels!.status).toBe("failure");
  });

  it("advertises available when run completions exist, unavailable+reason otherwise", () => {
    const ok = new CronRunTelemetryProducer({
      journalRunner: () => journalLine({ unit: "wisecron-a.service", ts: IN, exit: 0 }),
    });
    expect(ok.capabilities()[0]!.available).toBe(true);

    const empty = new CronRunTelemetryProducer({ journalRunner: () => "" });
    const cap = empty.capabilities()[0]!;
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/no .* run completions/);
  });

  it("returns [] (does not throw) when the journal runner fails", async () => {
    const p = new CronRunTelemetryProducer({
      journalRunner: () => {
        throw new Error("journalctl missing");
      },
    });
    expect(await p.query("cron_run", RANGE)).toEqual([]);
    expect(p.capabilities()[0]!.available).toBe(false);
  });

  it("returns [] for any non-cron_run stream", async () => {
    const p = new CronRunTelemetryProducer({ journalRunner: () => "" });
    expect(await p.query("hook_exec", RANGE)).toEqual([]);
  });
});

describe("HookExecTelemetryProducer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hooks-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("emits hook_exec with value=duration_ms and exit_code/event labels", async () => {
    writeFileSync(
      join(dir, "pre.log"),
      [
        JSON.stringify({
          hook: "pre",
          exit_code: 0,
          duration_ms: 120,
          event: "UserPromptSubmit",
          ts: IN.toISOString(),
        }),
        JSON.stringify({
          hook: "pre",
          exit_code: 2,
          duration_ms: 999,
          event: "UserPromptSubmit",
          ts: IN.toISOString(),
        }),
        JSON.stringify({
          hook: "pre",
          exit_code: 0,
          duration_ms: 50,
          event: "x",
          ts: OUT.toISOString(),
        }), // out of window
        "not json",
      ].join("\n"),
    );
    const p = new HookExecTelemetryProducer({ hooksDir: dir });
    const samples = await p.query("hook_exec", RANGE);
    expect(samples).toHaveLength(2);
    expect(samples.map((s) => s.value).sort((a, b) => a - b)).toEqual([120, 999]);
    expect(samples.find((s) => s.value === 999)!.labels!.exit_code).toBe("2");
    expect(p.capabilities()[0]!.available).toBe(true);
  });

  it("advertises unavailable+reason when no *.log present", () => {
    const p = new HookExecTelemetryProducer({ hooksDir: dir });
    const cap = p.capabilities()[0]!;
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/no parseable .* entries/);
  });
});

describe("SkillAccessTelemetryProducer", () => {
  let dir: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-"));
    log = join(dir, "skill_accesses.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("emits one skill_access sample per in-window access, labelled by skill name", async () => {
    writeFileSync(
      log,
      [
        JSON.stringify({
          skill_path: "/home/x/agent/skills/foo.md",
          accessed_at: IN.toISOString(),
        }),
        JSON.stringify({
          skill_path: "/home/x/agent/skills/foo.md",
          accessed_at: IN.toISOString(),
        }),
        JSON.stringify({
          skill_path: "/home/x/agent/skills/bar.md",
          accessed_at: OUT.toISOString(),
        }), // out
      ].join("\n"),
    );
    const p = new SkillAccessTelemetryProducer({ accessLog: log });
    const samples = await p.query("skill_access", RANGE);
    expect(samples).toHaveLength(2);
    expect(samples[0]!.value).toBe(1);
    expect(samples[0]!.labels!.skill).toBe("foo");
    expect(p.capabilities()[0]!.available).toBe(true);
  });

  it("advertises unavailable+reason when the log is absent", () => {
    const p = new SkillAccessTelemetryProducer({ accessLog: join(dir, "missing.jsonl") });
    expect(p.capabilities()[0]!.available).toBe(false);
    expect(p.capabilities()[0]!.reason).toMatch(/no skill-access entries/);
  });
});

describe("JournalTelemetryProducer", () => {
  let dir: string;
  let journal: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "journal-"));
    journal = join(dir, "operations.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("advertises the 4 derived streams unavailable+reason when no matching events", () => {
    writeFileSync(journal, JSON.stringify({ type: "deploy", ts: IN.toISOString() }) + "\n");
    const p = new JournalTelemetryProducer({ journalPath: journal });
    const caps = p.capabilities();
    expect(caps.map((c) => c.stream).sort()).toEqual([
      "agent_dispatch",
      "memory_access",
      "mode_dispatch",
      "tool_call",
    ]);
    expect(caps.every((c) => c.available === false && /no '.*' events/.test(c.reason ?? ""))).toBe(
      true,
    );
  });

  it("activates + emits a stream when matching events appear (no faked data)", async () => {
    writeFileSync(
      journal,
      [
        JSON.stringify({
          type: "tool_call",
          tool: "Read",
          server: "fs",
          success: true,
          ts: IN.toISOString(),
        }),
        JSON.stringify({
          type: "tool_call",
          tool: "Bash",
          server: "fs",
          success: false,
          ts: IN.toISOString(),
        }),
        JSON.stringify({ type: "deploy", ts: IN.toISOString() }),
      ].join("\n"),
    );
    const p = new JournalTelemetryProducer({ journalPath: journal });
    const cap = p.capabilities().find((c) => c.stream === "tool_call")!;
    expect(cap.available).toBe(true);
    const samples = await p.query("tool_call", RANGE);
    expect(samples).toHaveLength(2);
    // value 1 = failed/blocked, 0 = ok
    expect(samples.map((s) => s.value).sort()).toEqual([0, 1]);
  });

  it("reports journal-not-found reason when the file is absent", () => {
    const p = new JournalTelemetryProducer({ journalPath: join(dir, "nope.jsonl") });
    expect(p.capabilities().every((c) => /journal not found/.test(c.reason ?? ""))).toBe(true);
  });
});

describe("CompositeTelemetryProvider", () => {
  /** A trivial provider owning exactly one stream. */
  function one(
    stream: TelemetryStream,
    available: boolean,
    samples: MetricSample[],
  ): TelemetryProvider {
    return {
      contractVersion: () => "1.0.0",
      capabilities: () => [
        {
          stream,
          schemaVersion: "1.0.0",
          available,
          ...(available ? {} : { reason: `${stream} down` }),
        },
      ],
      query: async (s) => (s === stream ? samples : []),
    };
  }

  it("merges to one capability per contract stream, preferring available", () => {
    const c = new CompositeTelemetryProvider([
      one("cron_run", true, []),
      one("hook_exec", false, []),
    ]);
    const caps = c.capabilities();
    // Exactly one entry per declared stream.
    expect(caps).toHaveLength(TELEMETRY_STREAMS.length);
    expect(caps.find((x) => x.stream === "cron_run")!.available).toBe(true);
    expect(caps.find((x) => x.stream === "hook_exec")!.available).toBe(false);
    // A stream no producer claims is reported unavailable with a reason.
    const uncovered = caps.find((x) => x.stream === "agent_dispatch")!;
    expect(uncovered.available).toBe(false);
    expect(uncovered.reason).toMatch(/no producer wired/);
  });

  it("upgrades an unavailable stream to available when a later producer emits it", () => {
    const c = new CompositeTelemetryProvider([
      one("session_cost", false, []),
      one("session_cost", true, []),
    ]);
    expect(c.capabilities().find((x) => x.stream === "session_cost")!.available).toBe(true);
  });

  it("query concatenates across producers (each returns [] for unowned streams)", async () => {
    const sample: MetricSample = { ts: IN, value: 5, labels: {} };
    const c = new CompositeTelemetryProvider([
      one("cron_run", true, [sample]),
      one("hook_exec", true, []),
    ]);
    expect(await c.query("cron_run", RANGE)).toEqual([sample]);
    expect(await c.query("hook_exec", RANGE)).toEqual([]);
  });
});

describe("buildHostTelemetryProvider (real host wiring)", () => {
  it("returns a provider advertising one capability per declared stream", () => {
    const dir = mkdtempSync(join(tmpdir(), "host-"));
    mkdirSync(join(dir, "hooks"), { recursive: true });
    const p = buildHostTelemetryProvider({
      costDbPath: join(dir, "costs.db"),
      hooksDir: join(dir, "hooks"),
      skillAccessLog: join(dir, "skills.jsonl"),
      journalPath: join(dir, "ops.jsonl"),
      cronJournalRunner: () => "",
    });
    const caps = p.capabilities();
    expect(caps).toHaveLength(TELEMETRY_STREAMS.length);
    // Nothing seeded → every stream degrades to unavailable, each with a reason.
    expect(caps.every((c) => c.available === false && !!c.reason)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
