import { z } from "zod";
import type { PluginTool } from "../../mcp-bridge.js";
import type { EngineBundle } from "../../../skills-tuner/cli/bootstrap.js";
import { auditLog } from "../../../skills-tuner/core/security.js";
import { RefusedStore } from "../../../skills-tuner/storage/refused.js";

export function makeFeedbackTool(bundle: EngineBundle): PluginTool {
  return {
    name: "tuner_feedback",
    description: "Record user feedback on a proposal. 'no' also marks it refused.",
    schema: z.object({
      id: z.number().int().describe("Proposal ID."),
      preferred: z.enum(["yes", "yes-but", "no"]).describe("Feedback sentiment."),
    }),
    handler: ({ id, preferred }) => {
      const all = bundle.proposals.readAll();
      const record = all.find((r) => r?.proposal?.id === id);
      if (!record) throw new Error(`Proposal #${id} not found`);

      if (preferred === "no") {
        const refusedPath = bundle.refused.path;
        const refused = new RefusedStore(refusedPath);
        refused.add(record.proposal.pattern_signature, record.proposal.subject, `feedback:${preferred}`);
        bundle.proposals.append({ proposal: record.proposal, event: "refused", ts: new Date().toISOString() });
      }

      auditLog("feedback_recorded", { proposal_id: id, preferred });
      return { recorded: true };
    },
  };
}
