import { z } from "zod";
import type { PluginTool } from "../../mcp-bridge.js";
import type { EngineBundle } from "../../../skills-tuner/cli/bootstrap.js";

function parseDuration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) return 24 * 60 * 60 * 1000;
  const n = parseInt(m[1] as string, 10);
  switch (m[2]) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}

export function makeCronRunTool(bundle: EngineBundle): PluginTool {
  return {
    name: "tuner_cron_run",
    description: "Run the detection + proposal cycle. Scans session history and proposes skill improvements.",
    schema: z.object({
      since: z.string().optional().describe("Time window, e.g. '24h', '7d'. Defaults to '24h'."),
      dry: z.boolean().optional().describe("If true, propose but do not apply anything."),
      subject: z.string().optional().describe("Run only this subject name."),
    }).strict(),
    handler: async ({ since, dry, subject }) => {
      const sinceMs = parseDuration(since ?? "24h");
      const sinceDate = new Date(Date.now() - sinceMs);
      const result = await bundle.engine.runCycle({
        since: sinceDate,
        subjectName: subject,
        dryRun: dry ?? false,
      });
      return {
        proposed: result.proposed,
        auto_applied: result.autoApplied,
        errors: [] as string[],
      };
    },
  };
}
