import { z } from "zod";
import type { PluginTool } from "../../mcp-bridge.js";
import type { EngineBundle } from "../../../skills-tuner/cli/bootstrap.js";

export function makeSkipTool(bundle: EngineBundle): PluginTool {
  return {
    name: "tuner_skip",
    description: "Skip (refuse) a pending proposal, optionally recording a reason.",
    schema: z.object({
      id: z.number().int().describe("Proposal ID to skip."),
      reason: z.string().optional().describe("Optional reason for skipping."),
    }),
    handler: async ({ id, reason }) => {
      await bundle.engine.refuseProposal(id, reason ?? "skip");
      return { skipped: true };
    },
  };
}
