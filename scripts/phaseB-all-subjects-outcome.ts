/**
 * Phase B driver — REAL per-subject fitness measurement across the host.
 *
 * Builds the composite host telemetry provider over real sources
 * (~/agent/data/costs.db, journalctl wisecron-*, ~/.claude/hooks/*.log,
 * ~/.config/tuner/skill_accesses.jsonl, ~/.claudeclaw/journal/operations.jsonl)
 * then, for each producer-backed subject, calls `measureFitness` over a real
 * window and prints what came out of real data — number per active metric, or
 * an explicit "source absent (degrade)" note. READ-ONLY.
 *
 * Usage: bun run scripts/phaseB-all-subjects-outcome.ts [windowDays]
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { DateRange } from "../src/skills-tuner/core/telemetry.js";
import { HookSubject } from "../src/tuner/subjects/hook-subject.js";
import { McpPluginSubject } from "../src/tuner/subjects/mcp-plugin-subject.js";
import { ModelRoutingSubject } from "../src/tuner/subjects/model-routing-subject.js";
import { PromptTemplateSubject } from "../src/tuner/subjects/prompt-template-subject.js";
import { MemorySubject } from "../src/tuner/subjects/memory-subject.js";
import { AgentSubject } from "../src/tuner/subjects/agent-subject.js";
import { CronSubject } from "../src/tuner/subjects/cron-subject.js";
import { ClaudeMdSubject } from "../src/tuner/subjects/claude-md-subject.js";
import type { BaseSubject } from "../src/skills-tuner/subjects/base.js";
import { buildHostTelemetryProvider } from "../src/tuner/wisecron/host-telemetry-provider.js";

const windowDays = Number(process.argv[2] ?? 30);
const end = new Date();
const start = new Date(end.getTime() - windowDays * 86_400_000);
const range: DateRange = { start, end };

async function main(): Promise<void> {
  const provider = buildHostTelemetryProvider({
    costDbPath: join(homedir(), "agent", "data", "costs.db"),
  });

  console.log("=== Phase B — real per-subject fitness measurement ===");
  console.log(`window: ${start.toISOString()} → ${end.toISOString()} (${windowDays}d)\n`);

  console.log("[provider capabilities]");
  for (const c of provider.capabilities()) {
    console.log(
      `  ${c.stream.padEnd(18)} available=${c.available}${c.reason ? `  reason="${c.reason}"` : ""}`,
    );
  }
  console.log("");

  // Each subject uses host defaults (no injected config) so paths are the real
  // ones an operator runs against.
  const subjects: BaseSubject[] = [
    new CronSubject(),
    new ClaudeMdSubject(),
    new HookSubject(),
    new McpPluginSubject(),
    new ModelRoutingSubject(),
    new PromptTemplateSubject(),
    new MemorySubject(),
    new AgentSubject(),
  ];

  console.log("[measured fitness per subject]");
  for (const subject of subjects) {
    const declared = subject.fitnessSignals();
    let measured: Record<string, number> = {};
    try {
      measured = await subject.measureFitness(range, provider);
    } catch (e) {
      console.log(
        `  ${subject.name}: measureFitness threw — ${(e as Error).message.slice(0, 100)}`,
      );
      continue;
    }
    console.log(`  ${subject.name} (declares ${declared.length} metric(s)):`);
    for (const m of declared) {
      const v = measured[m.name];
      if (v === undefined) {
        console.log(
          `      ${m.name.padEnd(34)} —  (source=${m.source}, not measured: producer/source absent)`,
        );
      } else {
        console.log(`      ${m.name.padEnd(34)} = ${v}  (source=${m.source})`);
      }
    }
  }
  console.log("\n=== done ===");
}

await main();
