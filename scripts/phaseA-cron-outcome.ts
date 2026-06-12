/**
 * Phase A driver — produce the FIRST real measured OutcomeLoop outcome.
 *
 * Closes the loop end-to-end on ONE real stream-backed subject (cron / cost):
 *  1. Build the real `session_cost` TelemetryProvider over ~/agent/data/costs.db.
 *  2. Run the activation gate through `registerWisecronSubjects({ telemetry })`
 *     so the boot log shows `fitness: active metric='cron_cost' source=session_cost`.
 *  3. Drive `OutcomeRecorder` across two REAL historical cost windows
 *     (baseline window → post window) so baseline, post, delta and verdict all
 *     come out of real telemetry, then write the row(s) to
 *     ~/.config/tuner/outcomes.jsonl (the JSONL projection of the SQLite ledger).
 *
 * We cannot time-travel 7 days, so a controllable clock represents
 * "before the change" (baseline window end) and "after the change"
 * (maturation asOf). The measurement code path is exercised exactly as in
 * production; only the clock is injected. READ-ONLY w.r.t. costs.db.
 *
 * Usage: bun run scripts/phaseA-cron-outcome.ts [baselineEndISO] [postEndISO]
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Registry } from "../src/skills-tuner/core/registry.js";
import { AuditLog } from "../src/skills-tuner/core/audit-log.js";
import { CronSubject } from "../src/tuner/subjects/cron-subject.js";
import { WisecronStateDB } from "../src/tuner/wisecron/state-db.js";
import { OutcomeRecorder } from "../src/tuner/wisecron/outcome-loop.js";
import { registerWisecronSubjects } from "../src/tuner/wisecron/index.js";
import { SessionCostTelemetryProvider } from "../src/tuner/wisecron/session-cost-provider.js";
import type { Proposal } from "../src/skills-tuner/core/types.js";
import type { ScheduledJob, SchedulerBackend } from "../src/skills-tuner/schedulers/base.js";
import type { WisecronSettings } from "../src/tuner/wisecron/types.js";

const COSTS_DB = join(homedir(), "agent", "data", "costs.db");
const OUTCOMES_JSONL = join(homedir(), ".config", "tuner", "outcomes.jsonl");

// Two real 7-day windows straddling the cron-attributed cost data, which in
// this fixture only spans 2026-05-20..05-24. baseline=[05-15,05-22) captures
// the 05-20/05-21 cron sessions; post=[05-22,05-29) captures 05-22..05-24.
const baselineEnd = new Date(process.argv[2] ?? "2026-05-22T00:00:00.000Z");
const postEnd = new Date(process.argv[3] ?? "2026-05-29T00:00:00.000Z");

/** Deterministic scheduler stub: a couple of active managed units. */
function scheduler(jobs: Array<Pick<ScheduledJob, "name" | "status">>): SchedulerBackend {
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

function demoProposal(): Proposal {
  return {
    id: Date.now(),
    cluster_id: "cron-high-error-rate",
    subject: "cron",
    kind: "cron_change",
    target_path: "wisecron-demo.service",
    alternatives: [
      {
        id: "adjust-schedule",
        label: "Halve fire frequency for wisecron-demo",
        diff_or_content: JSON.stringify({
          name: "wisecron-demo",
          schedule: "*-*-* */12:00:00",
          command: "/bin/true",
        }),
        tradeoff: "fewer fires → lower cost, lower coverage",
      },
    ],
    pattern_signature: "cron:high-error-rate:wisecron-demo.service",
    created_at: new Date(),
    signature: "demo",
  };
}

async function main(): Promise<void> {
  console.log(`\n=== Phase A — real cron OutcomeLoop ===`);
  console.log(`cost store : ${COSTS_DB}`);
  console.log(`baseline window ends: ${baselineEnd.toISOString()}`);
  console.log(`post     window ends: ${postEnd.toISOString()}\n`);

  const provider = new SessionCostTelemetryProvider({ dbPath: COSTS_DB });

  // ── 1. Provider reads real telemetry: contract + capabilities ────────────
  console.log(`[provider] contractVersion=${provider.contractVersion()}`);
  const sc = provider.capabilities().find((c) => c.stream === "session_cost")!;
  console.log(
    `[provider] session_cost available=${sc.available}${sc.reason ? ` reason="${sc.reason}"` : ""}`,
  );

  // Show how many cron-attributed samples each window actually holds.
  const cronWin = async (end: Date) => {
    const start = new Date(end.getTime() - 7 * 86_400_000);
    const all = await provider.query("session_cost", { start, end });
    const cron = all.filter((s) => (s.labels?.job ?? "").includes('source="cron"'));
    return { total: all.length, cron: cron.length, values: cron.map((s) => s.value) };
  };
  const bw = await cronWin(baselineEnd);
  const pw = await cronWin(postEnd);
  console.log(`[data] baseline window: ${bw.total} sessions, ${bw.cron} cron-attributed`);
  console.log(`[data] post     window: ${pw.total} sessions, ${pw.cron} cron-attributed\n`);

  // ── 2. Activation gate via the real registration path (task: wire telemetry)
  const gateAudit = new AuditLog();
  const gateRegistry = new Registry();
  const settings: WisecronSettings = {
    enabled: true,
    scope: "all",
    db_path: join(homedir(), ".config", "tuner", "phaseA-gate.db"),
    systemd_unit_prefix: "wisecron-",
    initial_interval_hours: 6,
    max_interval_hours: 168,
    llm_model_for_propose: "claude-sonnet-4-6",
    llm_call_path: "direct-sdk",
    subjects: {
      cron: {
        enabled: true,
        config: { scheduler: scheduler([{ name: "wisecron-demo", status: "active" }]) },
      },
      claude_md: { enabled: false },
      hook: { enabled: false },
      mcp_plugin: { enabled: false },
      model_routing: { enabled: false },
      prompt_template: { enabled: false },
      memory: { enabled: false },
      agent: { enabled: false },
    },
    rollback: { retention_days: 90, require_confirm_on_rollback: true },
  };
  console.log(`[gate] registerWisecronSubjects({ telemetry }) →`);
  registerWisecronSubjects(gateRegistry, settings, {
    telemetry: provider,
    audit: gateAudit,
    runHealthChecks: false,
  });
  console.log("");

  // ── 3. Full loop: baseline → maturation → verdict over real windows ──────
  const dbPath = join(homedir(), ".config", "tuner", "phaseA-outcomes.db");
  const db = new WisecronStateDB(dbPath);
  const registry = new Registry();
  registry.registerSubject(
    new CronSubject({ scheduler: scheduler([{ name: "wisecron-demo", status: "active" }]) }),
  );
  const audit = new AuditLog();

  let clock = baselineEnd;
  const rec = new OutcomeRecorder(registry, db, provider, audit, () => clock);

  const proposal = demoProposal();
  const proposalId = String(proposal.id);
  const commitSha = "phaseA-demo-sha";

  await rec.snapshotBaseline(proposal, commitSha);
  console.log(`[baseline] snapshotted ${db.getOutcomes(proposalId).length} metric row(s):`);
  for (const r of db.getOutcomes(proposalId)) {
    console.log(`           ${r.metric} baseline=${r.baseline} matures_at=${r.window_end}`);
  }

  // Advance the clock to the post window and mature.
  clock = postEnd;
  const results = await rec.runMaturation({
    revert: async (_id, tier) => tier === "low", // high-risk cron → enqueued, never auto
  });
  console.log(`\n[maturation] ${results.length} proposal(s) matured`);
  for (const m of results) {
    console.log(`           target=${m.target_metric} verdict=${m.verdict} reverted=${m.reverted}`);
  }

  // ── Project the SQLite ledger to outcomes.jsonl (the deliverable artifact) ─
  mkdirSync(dirname(OUTCOMES_JSONL), { recursive: true });
  const rows = db.getOutcomes(proposalId).map((r) => ({
    proposal_id: r.proposal_id,
    commit_sha: r.commit_sha,
    subject: r.subject,
    metric: r.metric,
    baseline: r.baseline,
    post: r.post,
    delta: r.delta,
    window_start: r.window_start,
    window_end: r.window_end,
    verdict: r.verdict,
  }));
  // Fresh file for this demo run.
  writeFileSync(OUTCOMES_JSONL, "");
  for (const row of rows) appendFileSync(OUTCOMES_JSONL, `${JSON.stringify(row)}\n`);

  console.log(`\n=== outcomes.jsonl (${OUTCOMES_JSONL}) ===`);
  for (const row of rows) console.log(JSON.stringify(row));

  console.log(`\n=== audit trail (gate + loop) ===`);
  for (const ev of [...gateAudit.all(), ...audit.all()]) {
    console.log(
      `  ${ev.event}${ev.metric ? ` metric=${ev.metric}` : ""}${ev.detail?.verdict ? ` verdict=${ev.detail.verdict}` : ""}${ev.detail?.reason ? ` reason="${ev.detail.reason}"` : ""}`,
    );
  }
  console.log(`\naudit chain verified: ${audit.verifyChain().ok}`);

  db.close();
  provider.close();
}

await main();
