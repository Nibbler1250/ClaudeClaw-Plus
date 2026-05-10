import { z } from "zod";
import type { PluginTool } from "../../mcp-bridge.js";
import type { EngineBundle } from "../../../skills-tuner/cli/bootstrap.js";

export function makePendingTool(bundle: EngineBundle): PluginTool {
  return {
    name: "tuner_pending",
    description: "List pending tuner proposals across all subjects.",
    schema: z.object({}).strict(),
    handler: () => {
      const all = bundle.proposals.readAll().filter((r) => r?.proposal);
      const resolved = new Set(
        all.filter((r) => r.event !== "created").map((r) => r.proposal.pattern_signature),
      );
      const pending = all
        .filter((r) => r.event === "created" && !resolved.has(r.proposal.pattern_signature))
        .map((r) => ({
          id: r.proposal.id,
          subject: r.proposal.subject,
          kind: r.proposal.kind,
          target_path: r.proposal.target_path,
          pattern_signature: r.proposal.pattern_signature,
          alternatives_count: r.proposal.alternatives.length,
          created_at:
            r.proposal.created_at instanceof Date
              ? r.proposal.created_at.toISOString()
              : String(r.proposal.created_at),
        }));
      return { pending };
    },
  };
}
