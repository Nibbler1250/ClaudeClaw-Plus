import { describe, it, expect } from "bun:test";
import { decideVerdict, guardrailMetricsFor } from "../../skills-tuner/core/verdict.js";
import type { Metric } from "../../skills-tuner/core/telemetry.js";

const lower = (name: string, guardrails?: string[]): Metric => ({
  name,
  source: "session_cost",
  kind: "verifiable",
  direction: "lower_is_better",
  windowDays: 7,
  ...(guardrails ? { guardrails } : {}),
});

describe("decideVerdict — no-regression rule", () => {
  it("improved: lower_is_better target drops beyond noise, no guardrail regression", () => {
    const v = decideVerdict({
      metric: "cost",
      direction: "lower_is_better",
      baseline: 100,
      post: 80,
    });
    expect(v).toBe("improved");
  });

  it("regressed: lower_is_better target rises beyond noise", () => {
    const v = decideVerdict({
      metric: "cost",
      direction: "lower_is_better",
      baseline: 100,
      post: 130,
    });
    expect(v).toBe("regressed");
  });

  it("neutral: move within noise band", () => {
    const v = decideVerdict({
      metric: "cost",
      direction: "lower_is_better",
      baseline: 100,
      post: 102,
    });
    expect(v).toBe("neutral");
  });

  it("higher_is_better improves when value rises", () => {
    const v = decideVerdict({
      metric: "hit",
      direction: "higher_is_better",
      baseline: 0.5,
      post: 0.7,
    });
    expect(v).toBe("improved");
  });

  it("guardrail regression overrides an improved target (anti-Goodhart)", () => {
    const target = {
      metric: "cost",
      direction: "lower_is_better" as const,
      baseline: 100,
      post: 60,
    };
    const guardrail = {
      metric: "critical_fire_success",
      direction: "higher_is_better" as const,
      baseline: 1.0,
      post: 0.5,
    };
    expect(decideVerdict(target, [guardrail])).toBe("regressed");
  });

  it("does not regress when guardrail holds steady", () => {
    const target = {
      metric: "cost",
      direction: "lower_is_better" as const,
      baseline: 100,
      post: 60,
    };
    const guardrail = {
      metric: "critical_fire_success",
      direction: "higher_is_better" as const,
      baseline: 1.0,
      post: 0.99,
    };
    expect(decideVerdict(target, [guardrail])).toBe("improved");
  });
});

describe("guardrailMetricsFor", () => {
  it("resolves declared guardrail metric objects by name", () => {
    const all = [
      lower("cron_cost", ["critical_fire_success"]),
      {
        name: "critical_fire_success",
        source: "cron_run",
        kind: "verifiable",
        direction: "higher_is_better",
        windowDays: 7,
      } as Metric,
    ];
    const g = guardrailMetricsFor(all[0]!, all);
    expect(g.map((m) => m.name)).toEqual(["critical_fire_success"]);
  });

  it("returns [] when a metric declares no guardrails", () => {
    expect(guardrailMetricsFor(lower("x"), [lower("x")])).toEqual([]);
  });
});
