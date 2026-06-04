/**
 * P0 — diagnose déterministe (0 LLM) : compare les capabilities + counts de
 * samples par stream entre la config VIDE (l'actuelle, bootstrap ligne 97) et
 * une config avec les VRAIS chemins du host. Prouve lesquels s'allument.
 *
 * Run: bun run scripts/tuner-telemetry-diagnose.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildHostTelemetryProvider,
  type HostTelemetryConfig,
} from "../src/tuner/wisecron/host-telemetry-provider.js";
import { TELEMETRY_STREAMS } from "../src/skills-tuner/core/telemetry.js";

const H = homedir();

// Les vrais chemins présents sur ce host (validés sur disque).
const REAL: HostTelemetryConfig = {
  costDbPath: join(H, "agent", "data", "costs.db"),
  hooksDir: join(H, ".claude", "hooks"),
  skillAccessLog: join(H, ".config", "tuner", "skill_accesses.jsonl"),
  journalPath: join(H, ".claudeclaw", "journal", "operations.jsonl"),
  modeDispatchLog: join(H, ".claudeclaw", "journal", "mode_dispatch.jsonl"),
  templateFeedbackLog: join(H, ".config", "tuner", "template_feedback.jsonl"),
  sessionProjectsDir: join(H, ".claude", "projects"),
  mcpToolCallLog: join(H, ".claudeclaw", "telemetry", "mcp-tool-calls.jsonl"),
};

const range = {
  start: new Date(Date.now() - 7 * 86_400_000),
  end: new Date(Date.now() + 86_400_000),
};

async function probe(label: string, cfg: HostTelemetryConfig) {
  const p = buildHostTelemetryProvider(cfg);
  const caps = new Map(p.capabilities().map((c) => [c.stream, c]));
  console.log(`\n=== ${label} ===`);
  console.log("stream".padEnd(20), "avail".padEnd(7), "samples(7j)", " reason");
  for (const s of TELEMETRY_STREAMS) {
    const c = caps.get(s);
    const avail = c?.available ? "YES" : "no";
    let n = 0;
    try {
      n = (await p.query(s, range)).length;
    } catch {
      n = -1;
    }
    const reason = c?.available ? "" : ` ${c?.reason ?? "?"}`;
    console.log(s.padEnd(20), avail.padEnd(7), String(n).padStart(8), reason.slice(0, 80));
  }
}

await probe("CONFIG VIDE  (buildHostTelemetryProvider({}))", {});
await probe("CONFIG RÉELLE (chemins du host)", REAL);
