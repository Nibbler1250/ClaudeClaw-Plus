/**
 * GovernanceClient - Unified interface to governance operations
 * 
 * Provides a single entry point for policy evaluation, approval management,
 * and governance telemetry across the codebase.
 */

import { evaluate, loadRules, type ToolRequestContext, type PolicyDecision } from "../policy/engine";
import { enqueue, listPending, findByEventId, findById, loadState as loadApprovalState, type ApprovalEntry } from "../policy/approval-queue";
import * as governance from "./index";

export interface GovernanceClientConfig {
  policyEnabled?: boolean;
  approvalEnabled?: boolean;
}

export class GovernanceClient {
  private config: GovernanceClientConfig;

  constructor(config: GovernanceClientConfig = {}) {
    this.config = {
      policyEnabled: config.policyEnabled ?? true,
      approvalEnabled: config.approvalEnabled ?? true,
    };
  }

  // --- Policy Engine ---
  
  /**
   * Evaluate a tool request against policy rules.
   */
  evaluateToolRequest(request: ToolRequestContext): PolicyDecision {
    if (!this.config.policyEnabled) {
      return {
        requestId: crypto.randomUUID(),
        action: "allow",
        reason: "Policy engine disabled",
        evaluatedAt: new Date().toISOString(),
        cacheable: false,
      };
    }
    return evaluate(request);
  }

  /**
   * Load/reload policy rules from disk.
   */
  async reloadPolicies(): Promise<void> {
    await loadRules();
  }

  // --- Approval Queue ---
  
  /**
   * Request approval for a tool execution.
   * Returns the approval entry if decision is require_approval.
   */
  async requestApproval(request: ToolRequestContext, decision: PolicyDecision): Promise<ApprovalEntry | null> {
    if (!this.config.approvalEnabled || decision.action !== "require_approval") {
      return null;
    }
    return enqueue(request, decision);
  }

  /**
   * Get all pending approvals.
   */
  getPendingApprovals(): ApprovalEntry[] {
    return listPending();
  }

  /**
   * Find approval by event ID.
   */
  async findApprovalByEvent(eventId: string): Promise<ApprovalEntry | null> {
    return findByEventId(eventId);
  }

  /**
   * Find approval by approval ID.
   */
  getApprovalById(id: string): ApprovalEntry | null {
    return findById(id);
  }

  // --- Governance Telemetry ---
  
  /**
   * Get governance telemetry summary.
   */
  async getTelemetry() {
    return governance.getTelemetry({});
  }

  /**
   * Get usage stats.
   */
  async getUsageStats() {
    return governance.getUsageStats();
  }

  /**
   * Get budget state.
   */
  async getBudgetState(channelId?: string) {
    return governance.getBudgetState(channelId);
  }

  /**
   * Check if a tool is allowed (shortcut for allow action).
   */
  isToolAllowed(request: ToolRequestContext): boolean {
    const decision = this.evaluateToolRequest(request);
    return decision.action === "allow";
  }

  /**
   * Check if a tool requires approval (shortcut for require_approval action).
   */
  requiresApproval(request: ToolRequestContext): boolean {
    const decision = this.evaluateToolRequest(request);
    return decision.action === "require_approval";
  }
}

// --- Singleton Instance ---

let governanceClientInstance: GovernanceClient | null = null;

export function getGovernanceClient(): GovernanceClient {
  if (!governanceClientInstance) {
    governanceClientInstance = new GovernanceClient();
  }
  return governanceClientInstance;
}

export function initGovernanceClient(config?: GovernanceClientConfig): GovernanceClient {
  governanceClientInstance = new GovernanceClient(config);
  return governanceClientInstance;
}
