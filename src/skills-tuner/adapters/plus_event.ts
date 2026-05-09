import { z } from 'zod';
import { Adapter } from '../core/interfaces.js';
import type { Proposal } from '../core/types.js';
import { getMcpBridge, type PluginTool } from '../../plugins/mcp-bridge.js';

/**
 * Plus event bus adapter — registers skills-tuner tools via the Plugin MCP Bridge (#31).
 *
 * Once the bridge is in place (closes #31), this adapter:
 *   1. registers tuner tools (proposal_render, apply_confirmation, etc.) at construction
 *   2. surfaces proposals through the registered tools (callable as MCP tools by any client)
 *   3. inherits HMAC signing, audit log, and per-plugin secret from the bridge
 *
 * The TelegramAdapter remains the user-facing surface for #14 inline buttons.
 * This adapter complements it by exposing the same operations to MCP clients
 * (Claude Code, scripts, other plugins).
 */
export class PlusEventAdapter extends Adapter {
  private static readonly PLUGIN_ID = 'skills-tuner';
  private registered = false;

  constructor(
    private onApply?: (proposalId: number, alternativeId: string) => Promise<void>,
    private onRefuse?: (proposalId: number) => Promise<void>,
  ) {
    super();
    this.registerTools();
  }

  private registerTools(): void {
    if (this.registered) return;
    const bridge = getMcpBridge();

    const proposalRenderSchema = z.object({
      id: z.number().int(),
      subject: z.string(),
      kind: z.string(),
      target_path: z.string(),
      pattern_signature: z.string(),
    });

    const applySchema = z.object({
      proposal_id: z.number().int(),
      alternative_id: z.string(),
    });

    const refuseSchema = z.object({
      proposal_id: z.number().int(),
    });

    const tools: PluginTool[] = [
      {
        name: 'tuner_proposal_render',
        description: 'Render a tuner proposal — emit notify event for downstream UIs',
        schema: proposalRenderSchema,
        handler: async (args) => {
          // emit-only: the actual UI rendering happens in TelegramAdapter
          // this tool is used by MCP clients to inspect or relay proposals
          return { acknowledged: true, proposal_id: (args as any).id };
        },
      },
      {
        name: 'tuner_apply',
        description: 'Apply an approved alternative for a tuner proposal',
        schema: applySchema,
        handler: async (args) => {
          const a = args as z.infer<typeof applySchema>;
          if (this.onApply) await this.onApply(a.proposal_id, a.alternative_id);
          return { applied: true, proposal_id: a.proposal_id, alternative_id: a.alternative_id };
        },
      },
      {
        name: 'tuner_refuse',
        description: 'Refuse a tuner proposal (records pattern_signature in refused.jsonl with TTL 30d)',
        schema: refuseSchema,
        handler: async (args) => {
          const a = args as z.infer<typeof refuseSchema>;
          if (this.onRefuse) await this.onRefuse(a.proposal_id);
          return { refused: true, proposal_id: a.proposal_id };
        },
      },
    ];

    for (const tool of tools) {
      try {
        bridge.registerPluginTool(PlusEventAdapter.PLUGIN_ID, tool);
      } catch (e) {
        // Already registered (idempotent for repeat instantiation in tests)
        if (!String(e).includes('already registered')) throw e;
      }
    }
    this.registered = true;
  }

  async renderProposal(proposal: Proposal): Promise<void> {
    const bridge = getMcpBridge();
    await bridge.invokeTool('skills-tuner__tuner_proposal_render', {
      id: proposal.id,
      subject: proposal.subject,
      kind: proposal.kind,
      target_path: proposal.target_path,
      pattern_signature: proposal.pattern_signature,
    });
  }

  async renderApplyConfirmation(proposal: Proposal, alternativeId: string): Promise<void> {
    // Record applied event through the bridge's audit log
    const bridge = getMcpBridge();
    await bridge.invokeTool('skills-tuner__tuner_apply', {
      proposal_id: proposal.id,
      alternative_id: alternativeId,
    });
  }
}
