import { z } from "zod";
import type { PluginTool } from "../../mcp-bridge.js";
import type { EngineBundle } from "../../../skills-tuner/cli/bootstrap.js";

export function makeRevertTool(bundle: EngineBundle): PluginTool {
  return {
    name: "tuner_revert",
    description: "Revert a previously applied proposal by undoing its git commit.",
    schema: z.object({
      id: z.number().int().describe("Proposal ID to revert."),
    }).strict(),
    handler: async ({ id }) => {
      const records = bundle.proposals.readAll();
      const applied = records.find((r) => r.proposal?.id === id && r.event === "applied");
      if (!applied) throw new Error(`No applied record found for proposal #${id}`);
      const commitSha = applied.commit_sha ?? "";
      await bundle.engine.revertProposal(id);
      return { reverted: true, commit_sha: commitSha };
    },
  };
}
