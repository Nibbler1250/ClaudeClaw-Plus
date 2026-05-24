import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerWisecronSubjects } from "../../wisecron/index.js";
import { Registry } from "../../../skills-tuner/core/registry.js";
import { WisecronSettingsSchema } from "../../wisecron/types.js";

let tmpDir: string;
let warnSpy: { calls: string[]; restore: () => void };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wisecron-register-"));
  const original = console.warn;
  const calls: string[] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args.map((a) => String(a)).join(" "));
  };
  warnSpy = {
    calls,
    restore: () => {
      console.warn = original;
    },
  };
});

afterEach(() => {
  warnSpy.restore();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeSettings() {
  return WisecronSettingsSchema.parse({
    enabled: true,
    db_path: join(tmpDir, "wisecron.db"),
  });
}

describe("registerWisecronSubjects — healthProbe boot warning", () => {
  it("emits NO healthProbe boot warning now that every medium/high-risk subject implements one", () => {
    const registry = new Registry();
    registerWisecronSubjects(registry, makeSettings());

    // cron (high), hook (high), claude_md (medium), mcp_plugin (medium),
    // model_routing (medium) now all ship a healthProbe — the fail-open
    // "auto-revert disabled" warning must be gone for every one of them.
    const matchingWarnings = warnSpy.calls.filter((c) =>
      /\[tuner\] subject '\w+' \(risk=(high|medium)\) has no healthProbe/.test(c),
    );
    expect(matchingWarnings).toHaveLength(0);
    for (const name of ["cron", "hook", "claude_md", "mcp_plugin", "model_routing"]) {
      expect(
        warnSpy.calls.some((c) => c.includes(`'${name}'`) && c.includes("has no healthProbe")),
      ).toBe(false);
    }
  });

  it("does not warn for low-risk subjects", () => {
    const registry = new Registry();
    registerWisecronSubjects(registry, makeSettings());

    // agent, memory, prompt_template are low-risk — no warning expected.
    expect(warnSpy.calls.some((c) => /'agent'/.test(c) && /healthProbe/.test(c))).toBe(false);
    expect(warnSpy.calls.some((c) => /'memory'/.test(c) && /healthProbe/.test(c))).toBe(false);
    expect(warnSpy.calls.some((c) => /'prompt_template'/.test(c) && /healthProbe/.test(c))).toBe(
      false,
    );
  });

  it("honors disabled subjects (no warning fired for disabled high-risk subject)", () => {
    const registry = new Registry();
    const settings = WisecronSettingsSchema.parse({
      enabled: true,
      db_path: join(tmpDir, "wisecron.db"),
      subjects: { cron: { enabled: false }, hook: { enabled: false } },
    });
    registerWisecronSubjects(registry, settings);

    expect(warnSpy.calls.some((c) => /'cron'/.test(c) && /healthProbe/.test(c))).toBe(false);
    expect(warnSpy.calls.some((c) => /'hook'/.test(c) && /healthProbe/.test(c))).toBe(false);
  });

  it("schema accepts subjects.hook.config.hooksDir without error", () => {
    const settings = WisecronSettingsSchema.parse({
      enabled: true,
      db_path: join(tmpDir, "wisecron.db"),
      subjects: {
        hook: { enabled: true, config: { hooksDir: "~/agent/hooks" } },
        agent: { enabled: true, config: { agentsDir: "~/agent/agents" } },
      },
    });
    expect(settings.subjects?.hook?.config?.hooksDir).toBe("~/agent/hooks");
    expect(settings.subjects?.agent?.config?.agentsDir).toBe("~/agent/agents");
  });

  it("schema parses backwards-compat input with no config field", () => {
    const settings = WisecronSettingsSchema.parse({
      enabled: true,
      db_path: join(tmpDir, "wisecron.db"),
      subjects: {
        hook: { enabled: true },
        agent: { enabled: false },
      },
    });
    expect(settings.subjects?.hook?.config).toBeUndefined();
    expect(settings.subjects?.hook?.enabled).toBe(true);
    expect(settings.subjects?.agent?.enabled).toBe(false);
  });

  it("per-subject config is forwarded to subject constructor (observable side effect)", () => {
    // Inspect the registered HookSubject's `hooksDir` directly — patching the
    // ESM module export isn't allowed (readonly), so we verify the override
    // landed by reading the private field on the constructed instance.
    const registry = new Registry();
    const settings = WisecronSettingsSchema.parse({
      enabled: true,
      db_path: join(tmpDir, "wisecron.db"),
      subjects: { hook: { enabled: true, config: { hooksDir: "/custom/hooks" } } },
    });
    registerWisecronSubjects(registry, settings);
    const hookSubject = registry.getSubject("hook") as unknown as { hooksDir: string };
    expect(hookSubject).toBeDefined();
    expect(hookSubject.hooksDir).toBe("/custom/hooks");
  });

  it("per-subject config forwarded to AgentSubject too (covers a second subject)", () => {
    const registry = new Registry();
    const settings = WisecronSettingsSchema.parse({
      enabled: true,
      db_path: join(tmpDir, "wisecron.db"),
      subjects: { agent: { enabled: true, config: { agentsDir: "/custom/agents" } } },
    });
    registerWisecronSubjects(registry, settings);
    const agentSubject = registry.getSubject("agent") as unknown as { agentsDir: string };
    expect(agentSubject).toBeDefined();
    expect(agentSubject.agentsDir).toBe("/custom/agents");
  });

  it("subjects with no config field still register with default ctor (backwards-compat)", () => {
    const registry = new Registry();
    const settings = WisecronSettingsSchema.parse({
      enabled: true,
      db_path: join(tmpDir, "wisecron.db"),
      subjects: {
        // hook entry without `config` — must still register with defaults.
        hook: { enabled: true },
        memory: { enabled: true },
      },
    });
    expect(() => registerWisecronSubjects(registry, settings)).not.toThrow();
    const subjects = registry.allSubjects();
    expect(subjects.some((s) => s.name === "hook")).toBe(true);
    expect(subjects.some((s) => s.name === "memory")).toBe(true);
  });

  it("runHealthChecks logs producer_found per subject at boot", async () => {
    const registry = new Registry();
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((a) => String(a)).join(" "));
    };
    try {
      // runHealthChecks defaults to true; fire and await the next microtask
      // round so the async health calls settle.
      registerWisecronSubjects(registry, makeSettings());
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      console.log = origLog;
    }
    const healthLines = [...logCalls, ...warnSpy.calls].filter((c) =>
      /\[tuner\] subject '\w+' health:/.test(c),
    );
    // At least the 5 producer-dependent subjects must log a line.
    const subjectNames = new Set(healthLines.map((c) => c.match(/'(\w+)'/)?.[1]));
    expect(subjectNames.has("cron")).toBe(true);
    expect(subjectNames.has("hook")).toBe(true);
    expect(subjectNames.has("mcp_plugin")).toBe(true);
    expect(subjectNames.has("model_routing")).toBe(true);
    expect(subjectNames.has("prompt_template")).toBe(true);
  });

  it("runHealthChecks can be disabled via opts.runHealthChecks=false", async () => {
    const registry = new Registry();
    const logCalls: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map((a) => String(a)).join(" "));
    };
    try {
      registerWisecronSubjects(registry, makeSettings(), { runHealthChecks: false });
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      console.log = origLog;
    }
    const healthLines = [...logCalls, ...warnSpy.calls].filter((c) =>
      /\[tuner\] subject '\w+' health:/.test(c),
    );
    expect(healthLines.length).toBe(0);
  });

  it("suppresses the warning when subject defines its own healthProbe", () => {
    const registry = new Registry();
    // Spy a subject in flight: monkey-patch CronSubject prototype to add a
    // healthProbe stub via the registry side-channel. Since registerWisecronSubjects
    // owns instantiation, we patch the prototype before calling it.
    const { CronSubject } = require("../../subjects/cron-subject.js");
    const original = CronSubject.prototype.healthProbe;
    CronSubject.prototype.healthProbe = async () => ({ failed: false, errors: [] });
    try {
      registerWisecronSubjects(registry, makeSettings());
      expect(warnSpy.calls.some((c) => /'cron'/.test(c) && /healthProbe/.test(c))).toBe(false);
    } finally {
      if (original === undefined) delete CronSubject.prototype.healthProbe;
      else CronSubject.prototype.healthProbe = original;
    }
  });
});
