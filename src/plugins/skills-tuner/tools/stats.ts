import { z } from "zod";
import type { PluginTool } from "../../mcp-bridge.js";
import type { EngineBundle } from "../../../skills-tuner/cli/bootstrap.js";

export function makeStatsTool(bundle: EngineBundle): PluginTool {
  return {
    name: "tuner_stats",
    description: "Show proposal statistics: total records, counts by event type, and breakdown by subject.",
    schema: z.object({}).strict(),
    handler: () => {
      const all = bundle.proposals.readAll();
      const counts = { created: 0, applied: 0, refused: 0 };
      const bySubject: Record<string, { created: number; applied: number; refused: number }> = {};
      for (const r of all) {
        if (r.event in counts) counts[r.event as keyof typeof counts]++;
        if (!bySubject[r.proposal.subject]) {
          bySubject[r.proposal.subject] = { created: 0, applied: 0, refused: 0 };
        }
        const sub = bySubject[r.proposal.subject]!;
        if (r.event in sub) sub[r.event as keyof typeof sub]++;
      }
      return {
        total: all.length,
        created: counts.created,
        applied: counts.applied,
        refused: counts.refused,
        by_subject: bySubject,
      };
    },
  };
}
