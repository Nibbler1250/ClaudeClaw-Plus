/**
 * The uniform MCP tool-call event — the atom of the Phase A observability hub.
 *
 * The gateway (mcp-multiplexer) emits ONE of these per `tools/call`, for every
 * plugin, with no per-plugin code. Boundary metrics only: call args are reduced
 * to a stable, non-reversible hash (`args_hash`) — raw args never leave the call
 * scope (privacy/audit). External (upstream) traffic is out of scope; this is the
 * gateway boundary, and depth is plugin-opt-in via the view-manifest.
 */

import { createHash } from "node:crypto";

/** The telemetry stream id AND the audit event name share this literal. */
export const MCP_TOOL_CALL_STREAM = "mcp.tool_call" as const;
export const MCP_TOOL_CALL_EVENT = "mcp.tool_call" as const;

export type ToolCallStatus = "ok" | "error";

export interface ToolCallEvent {
  /** ISO-8601 — the call's own timestamp, not the (possibly later) flush time. */
  ts: string;
  /** Upstream MCP server name = the plugin label the hub auto-discovers on. */
  plugin: string;
  tool: string;
  /** PTY/bucket identity the call was dispatched under. */
  agent_id: string;
  status: ToolCallStatus;
  duration_ms: number;
  args_hash: string;
  /** Present only on `status: "error"`. */
  error?: string;
}

/**
 * Stable, non-reversible digest of call arguments. 16 hex chars is enough to
 * spot identical-arg repeats without exposing — or being able to reconstruct —
 * the payload. Never throws (falls back to a string coercion for exotic input).
 */
export function hashArgs(args: unknown): string {
  let serial: string;
  try {
    serial = JSON.stringify(args ?? null);
  } catch {
    serial = String(args);
  }
  return createHash("sha256").update(serial).digest("hex").slice(0, 16);
}
