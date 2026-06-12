/**
 * Stage 6 — E2E: ExternalProcessSubject ↔ the real pattern_detector_adapter.py.
 *
 * Drives the full loop through the subject (so every result is validated by the
 * subject's zod schemas): collect → detect → propose → apply (patch into a temp
 * dir, behind the allowedRoots guard) → measure_fitness (temp journal). Skipped
 * when the Python adapter worktree isn't present, so the TS suite stays green
 * standalone.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalProcessSubject } from "../skills-tuner/subjects/external_process";
import { NullTelemetryProvider } from "../skills-tuner/core/telemetry";
import type { Observation, Proposal, UnsignedProposal } from "../skills-tuner/core/types";

const ADAPTER =
  "/home/simon/Projects/momentum_trader-tuner/main/scripts/tuner/pattern_detector_adapter.py";
const ADAPTER_CWD = "/home/simon/Projects/momentum_trader-tuner/main";
const HAVE_ADAPTER = existsSync(ADAPTER);

const cleanups: string[] = [];
afterAll(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function isoDay(i: number): string {
  return new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
}

function csv(closes: number[]): string {
  const rows = ["date,open,high,low,close,volume"];
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i]!;
    const open = i === 0 ? c : closes[i - 1]!;
    rows.push(`${isoDay(i)},${open},${c * 1.005},${c * 0.995},${c},1000000`);
  }
  return rows.join("\n");
}

function flagCloses(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 55; i++) out.push(100);
  for (let i = 0; i < 15; i++) out.push(100 + (35 * i) / 14); // flagpole +35%
  for (let i = 0; i < 20; i++) out.push(135 - (6 * i) / 19); // slight downslope flag
  return out;
}

function noiseCloses(seed: number): number[] {
  // Deterministic pseudo-random walk (no external RNG dependence).
  let x = seed * 1000 + 1;
  let p = 100;
  const out: number[] = [];
  for (let i = 0; i < 90; i++) {
    x = (1103515245 * x + 12345) % 2147483648;
    p += (x / 2147483648 - 0.5) * 2.4;
    out.push(p);
  }
  return out;
}

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), "bf-e2e-"));
  cleanups.push(root);
  const dataDir = join(root, "ohlcv");
  const paramsDir = join(root, "params");
  mkdirSync(dataDir);
  mkdirSync(paramsDir);
  const symbols: string[] = [];
  for (let i = 0; i < 3; i++) {
    const s = `FLAG${i}`;
    writeFileSync(join(dataDir, `${s}.csv`), csv(flagCloses()));
    symbols.push(s);
  }
  for (let i = 0; i < 3; i++) {
    const s = `NOISE${i}`;
    writeFileSync(join(dataDir, `${s}.csv`), csv(noiseCloses(i)));
    symbols.push(s);
  }
  const paramsPath = join(paramsDir, "bull_flag_params.json");
  const journalPath = join(root, "conf.jsonl");
  const config = {
    subject_name: "pattern_detector",
    data_dir: dataDir,
    symbols,
    params_path: paramsPath,
    journal_path: journalPath,
    window_bars: 40,
    min_bars: 50,
    windows_per_symbol: 4,
    window_step: 5,
    oracle_threshold: 0.5,
  };
  return { root, paramsDir, paramsPath, journalPath, config };
}

function makeSubject(env: ReturnType<typeof makeEnv>): ExternalProcessSubject {
  return new ExternalProcessSubject({
    name: "pattern_detector",
    command: ["python3", ADAPTER],
    cwd: ADAPTER_CWD,
    allowedRoots: [env.paramsDir],
    riskTier: "high",
    autoMergeDefault: false,
    timeoutMs: 120_000,
    config: env.config,
    fitnessSignals: [
      {
        name: "bull_flag_conformity",
        source: "artifact",
        kind: "verifiable",
        direction: "higher_is_better",
        windowDays: 5,
      },
    ],
  });
}

describe.skipIf(!HAVE_ADAPTER)("E2E ExternalProcessSubject ↔ pattern_detector_adapter", () => {
  it("runs the full collect→detect→propose→apply→measure cycle", async () => {
    const env = makeEnv();
    const subj = makeSubject(env);

    // 1. collect → Observation[] (subject validates), journal line appended.
    const obs = await subj.collectObservations(new Date("2025-01-01T00:00:00Z"));
    expect(Array.isArray(obs)).toBe(true);
    expect(existsSync(env.journalPath)).toBe(true);
    const journalRec = JSON.parse(readFileSync(env.journalPath, "utf8").trim().split("\n")[0]!);
    expect(journalRec.conformity).toBeGreaterThanOrEqual(0);
    expect(journalRec.conformity).toBeLessThanOrEqual(1);
    expect(journalRec.n).toBeGreaterThan(0);

    // 2. detect — feed a known disagreement set so a cluster is guaranteed.
    const seeded: Observation[] = [
      {
        session_id: "s",
        observed_at: new Date("2025-05-01T00:00:00Z"),
        signal_type: "correction",
        verbatim: "X false positive",
        metadata: {
          symbol: "X",
          disagreement: "false_positive",
          oracle_score: 0.1,
          detected: true,
        },
      },
      {
        session_id: "s",
        observed_at: new Date("2025-05-01T00:00:00Z"),
        signal_type: "correction",
        verbatim: "Y false positive",
        metadata: {
          symbol: "Y",
          disagreement: "false_positive",
          oracle_score: 0.2,
          detected: true,
        },
      },
    ];
    const clusters = await subj.detectProblems(seeded);
    expect(clusters.length).toBe(1);
    expect(clusters[0]!.frequency).toBe(2);

    // 3. propose → UnsignedProposal (subject validates).
    const unsigned: UnsignedProposal = await subj.proposeChange(clusters[0]!);
    expect(unsigned.kind).toBe("param_tune");
    expect(unsigned.target_path).toBe(env.paramsPath);
    expect(unsigned.alternatives.length).toBeGreaterThanOrEqual(1);
    expect(unsigned.alternatives.length).toBeLessThanOrEqual(3);

    // 4. apply → Patch (subject validates + enforces allowedRoots).
    const proposal: Proposal = { ...unsigned, signature: "e2e-test-signature" };
    const altId = unsigned.alternatives[0]!.id;
    const patch = await subj.apply(proposal, altId);
    expect(patch.target_path).toBe(env.paramsPath);
    expect(existsSync(env.paramsPath)).toBe(false); // adapter never writes

    // Simulate the ApplyPipeline persisting the patch into the guarded zone.
    writeFileSync(patch.target_path, patch.applied_content);
    expect(existsSync(env.paramsPath)).toBe(true);

    // 5. validate the written patch.
    const result = await subj.validate(patch);
    expect(result.valid).toBe(true);

    // 6. measure_fitness reads the journal line from step 1.
    const fit = await subj.measureFitness(
      { start: new Date("2025-01-01T00:00:00Z"), end: new Date("2030-01-01T00:00:00Z") },
      new NullTelemetryProvider(),
    );
    expect(fit.bull_flag_conformity).toBeCloseTo(journalRec.conformity, 5);
  });

  it("apply refuses a target outside allowedRoots", async () => {
    const env = makeEnv();
    const subj = makeSubject(env);
    const proposal: Proposal = {
      id: 1,
      cluster_id: "c",
      subject: "pattern_detector",
      kind: "param_tune",
      target_path: "/etc/evil.json", // outside allowedRoots
      alternatives: [{ id: "a", label: "x", diff_or_content: "{}", tradeoff: "t" }],
      pattern_signature: "sig",
      created_at: new Date("2025-05-01T00:00:00Z"),
      signature: "e2e",
    };
    await expect(subj.apply(proposal, "a")).rejects.toThrow(/allowedRoots/);
  });
});
