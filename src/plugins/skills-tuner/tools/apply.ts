import { z } from "zod";
import type { PluginTool } from "../../mcp-bridge.js";
import type { EngineBundle } from "../../../skills-tuner/cli/bootstrap.js";

export function makeApplyTool(bundle: EngineBundle): PluginTool {
  return {
    name: "tuner_apply",
    description: "Apply a proposal alternative. HMAC-verified; respects scan_dirs path containment.",
    schema: z.object({
      id: z.number().int().describe("Proposal ID to apply."),
      alternative_id: z.enum(["A", "B", "C"]).describe("Alternative to apply."),
    }).strict(),
    handler: async ({ id, alternative_id }) => {
      await bundle.engine.applyProposal(id, alternative_id);
      const records = bundle.proposals.readAll();
      const applied = records.findLast((r) => r.proposal?.id === id && r.event === "applied");
      return {
        applied: true,
        commit_sha: applied?.commit_sha ?? "",
        path: applied?.applied_target_path ?? "",
      };
    },
  };
}
