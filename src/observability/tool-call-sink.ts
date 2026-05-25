/**
 * Fire-and-forget sink for `mcp.tool_call` events.
 *
 * NON-NEGOTIABLE: a hub hiccup can never stall tool I/O (the getUpdates-hang
 * lesson). The gateway calls `record()` on the hot dispatch path, so `record()`
 * is O(1), synchronous, never throws, never touches disk, and is NEVER awaited.
 * It only pushes to an in-memory buffer and arms a deferred flush. The flush
 * drains the buffer into a hash-chained `AuditLog` off the request path (a
 * macrotask), swallowing every error.
 *
 * The dedicated tool-call chain is its OWN file — never the tuner's outcome
 * audit chain — so high-volume call traffic can't bloat or couple to that
 * certifiable surface, while still being tamper-evident in its own right.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../skills-tuner/core/audit-log.js";
import { MCP_TOOL_CALL_EVENT, type ToolCallEvent } from "./tool-call.js";

export const DEFAULT_TOOL_CALL_LOG = join(
  homedir(),
  ".claudeclaw",
  "telemetry",
  "mcp-tool-calls.jsonl",
);

export interface ToolCallSinkOptions {
  /** Backing log path. `null`/`":memory:"` keeps the chain in memory. */
  path?: string | null;
  /** Arm a deferred timer flush on record (production). When false, the caller
   *  drives `flush()` — used by tests for deterministic assertions. Default true. */
  autoFlush?: boolean;
}

export class ToolCallSink {
  private enabled = true;
  private buffer: ToolCallEvent[] = [];
  private flushArmed = false;
  private log: AuditLog | null = null;
  private readonly path: string | null;
  private readonly autoFlush: boolean;
  /** Bound the buffer so a wedged flusher can't grow memory without limit;
   *  past the cap we DROP events rather than block or grow — telemetry is
   *  best-effort and must never threaten the daemon. */
  private static readonly MAX_BUFFER = 10_000;

  constructor(opts: ToolCallSinkOptions = {}) {
    this.path = opts.path === undefined ? DEFAULT_TOOL_CALL_LOG : opts.path;
    this.autoFlush = opts.autoFlush !== false;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
  isEnabled(): boolean {
    return this.enabled;
  }

  /** HOT PATH. Synchronous, O(1), never throws, never awaited. */
  record(event: ToolCallEvent): void {
    if (!this.enabled) return;
    if (this.buffer.length >= ToolCallSink.MAX_BUFFER) return;
    this.buffer.push(event);
    this.armFlush();
  }

  private armFlush(): void {
    if (!this.autoFlush) return;
    if (this.flushArmed) return;
    this.flushArmed = true;
    const t = setTimeout(() => {
      this.flushArmed = false;
      this.flush();
    }, 0);
    // Don't keep the event loop alive for a telemetry flush.
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
  }

  /**
   * Drain the buffer into the audited chain. Runs OFF the request path (timer
   * macrotask in production; callable directly in tests for determinism).
   */
  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      if (!this.log) this.log = new AuditLog(this.path ?? ":memory:");
      for (const e of batch) {
        this.log.append({
          event: MCP_TOOL_CALL_EVENT,
          subject: e.plugin,
          detail: {
            tool: e.tool,
            agent_id: e.agent_id,
            status: e.status,
            duration_ms: e.duration_ms,
            args_hash: e.args_hash,
            event_ts: e.ts,
            ...(e.error !== undefined ? { error: e.error } : {}),
          },
        });
      }
    } catch {
      // Fire-and-forget: a sink failure must never surface on the call path.
    }
  }

  /** Test helper — events buffered but not yet flushed. */
  pending(): readonly ToolCallEvent[] {
    return this.buffer;
  }
}

let sink: ToolCallSink | null = null;

export function getToolCallSink(): ToolCallSink {
  if (!sink) sink = new ToolCallSink();
  return sink;
}

/** The one call the gateway makes. Fire-and-forget by construction. */
export function recordToolCall(event: ToolCallEvent): void {
  getToolCallSink().record(event);
}

/** Test seam — swap in an isolated sink (e.g. `new ToolCallSink(tmpPath)`). */
export function __setToolCallSinkForTest(s: ToolCallSink | null): void {
  sink = s;
}
