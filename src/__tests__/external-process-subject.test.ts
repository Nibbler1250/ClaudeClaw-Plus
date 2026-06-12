import { describe, it, expect } from "bun:test";
import { ExternalProcessSubject } from "../skills-tuner/subjects/external_process";
import type { Metric } from "../skills-tuner/core/telemetry";
import { NullTelemetryProvider } from "../skills-tuner/core/telemetry";

/**
 * A canned JSON-RPC subprocess: reads one `{method, payload, config}` envelope
 * on stdin and writes `{result}`/`{error}` on stdout. Built as a `-e` one-liner
 * driven by the test runtime's own binary so the test stays hermetic (no PATH
 * assumptions, no fixture file).
 */
function mockSubprocess(body: string): string[] {
  return [process.execPath, "-e", body];
}

const ECHO_FITNESS = `
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const req = JSON.parse(s);
  if (req.method === "measure_fitness") {
    // Return a metric whose value is a deterministic function of the window
    // (span in whole days) so the test can assert the ISO window was forwarded
    // intact — without smuggling non-numbers into the numeric result record.
    const span = (Date.parse(req.payload.end) - Date.parse(req.payload.start)) / 86400000;
    process.stdout.write(JSON.stringify({ result: { bull_flag_conformity: span } }));
  } else {
    process.stdout.write(JSON.stringify({ result: {} }));
  }
  process.exit(0);
});
`;

const metric: Metric = {
  name: "bull_flag_conformity",
  source: "artifact",
  kind: "verifiable",
  direction: "higher_is_better",
  windowDays: 5,
};

describe("ExternalProcessSubject fitness proxy", () => {
  it("returns the statically-declared fitness metrics from config", () => {
    const subj = new ExternalProcessSubject({
      name: "pattern_detector",
      command: mockSubprocess(ECHO_FITNESS),
      allowedRoots: ["/tmp"],
      fitnessSignals: [metric],
    });
    const signals = subj.fitnessSignals();
    expect(signals).toEqual([metric]);
    // Returns a copy — mutating the result must not corrupt config state.
    signals.pop();
    expect(subj.fitnessSignals()).toHaveLength(1);
  });

  it("returns [] when no fitnessSignals are configured (backward-compatible)", () => {
    const subj = new ExternalProcessSubject({
      name: "x",
      command: mockSubprocess(ECHO_FITNESS),
    });
    expect(subj.fitnessSignals()).toEqual([]);
  });

  it("proxies measure_fitness, forwarding the ISO window and parsing numbers", async () => {
    const subj = new ExternalProcessSubject({
      name: "pattern_detector",
      command: mockSubprocess(ECHO_FITNESS),
      fitnessSignals: [metric],
    });
    const start = new Date("2026-05-01T00:00:00.000Z");
    const end = new Date("2026-05-06T00:00:00.000Z");
    const out = await subj.measureFitness({ start, end }, new NullTelemetryProvider());
    // 2026-05-01 → 2026-05-06 is a 5-day span: proves the ISO window was
    // forwarded to the subprocess intact and the numeric result parsed.
    expect(out.bull_flag_conformity).toBe(5);
  });

  it("rejects a measure_fitness result that is not Record<string, number>", async () => {
    const badBody = `
let s=""; process.stdin.on("data",d=>s+=d);
process.stdin.on("end",()=>{ process.stdout.write(JSON.stringify({result:{bull_flag_conformity:"not-a-number"}})); process.exit(0); });
`;
    const subj = new ExternalProcessSubject({
      name: "x",
      command: mockSubprocess(badBody),
      fitnessSignals: [metric],
    });
    await expect(
      subj.measureFitness({ start: new Date(), end: new Date() }, new NullTelemetryProvider()),
    ).rejects.toThrow();
  });
});
