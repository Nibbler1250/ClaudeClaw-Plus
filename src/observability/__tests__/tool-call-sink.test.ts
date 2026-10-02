import { describe, it, expect } from "bun:test";
import { AuditLog, type AuditRecord } from "../../skills-tuner/core/audit-log.js";
import { ToolCallSink } from "../tool-call-sink.js";
import type { ToolCallEvent } from "../tool-call.js";

function ev(over: Partial<ToolCallEvent>): ToolCallEvent {
  return {
    ts: "2026-05-25T12:00:00.000Z",
    plugin: "alpha",
    tool: "echo",
    agent_id: "pty-1",
    status: "ok",
    duration_ms: 10,
    ...over,
  };
}

/** Flush `events` through a sink backed by an in-memory chain; return what landed. */
function flushed(events: ToolCallEvent[]): readonly AuditRecord[] {
  const log = new AuditLog(":memory:");
  const sink = new ToolCallSink({ path: null, autoFlush: false, logFactory: () => log });
  for (const e of events) sink.record(e);
  sink.flush();
  return log.all();
}

describe("ToolCallSink — caller-supplied strings are bounded before they are persisted", () => {
  it("keeps a tool name at the cap and truncates one past it", () => {
    const atCap = "t".repeat(256);
    const overCap = `${"u".repeat(256)}${"x".repeat(1_000_000)}`;
    const [kept, cut] = flushed([ev({ tool: atCap }), ev({ tool: overCap, status: "error" })]);
    expect(kept?.detail?.tool).toBe(atCap);
    expect(cut?.detail?.tool).toBe(`${"u".repeat(256)}…[truncated 1000000 chars]`);
  });

  it("bounds the tool name on the enforce-mode intent record too", () => {
    const log = new AuditLog(":memory:");
    const sink = new ToolCallSink({
      path: null,
      autoFlush: false,
      policy: "enforce",
      logFactory: () => log,
    });
    sink.recordIntent({
      ts: "2026-05-25T12:00:00.000Z",
      plugin: "alpha",
      tool: "v".repeat(257),
      agent_id: "pty-1",
    });
    expect(log.all()[0]?.detail?.tool).toBe(`${"v".repeat(256)}…[truncated 1 chars]`);
  });

  it("truncates an error string past its own cap, independently of the tool cap", () => {
    const [rec] = flushed([ev({ status: "error", error: "e".repeat(2_001) })]);
    expect(rec?.detail?.error).toBe(`${"e".repeat(2_000)}…[truncated 1 chars]`);
  });
});
