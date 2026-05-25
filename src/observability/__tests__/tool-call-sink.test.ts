import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../../skills-tuner/core/audit-log.js";
import { ToolCallSink } from "../tool-call-sink.js";
import type { ToolCallEvent } from "../tool-call.js";

function ev(over: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    ts: "2026-05-25T12:00:00.000Z",
    plugin: "alpha",
    tool: "echo",
    agent_id: "pty-1",
    status: "ok",
    duration_ms: 4.2,
    args_hash: "deadbeefdeadbeef",
    ...over,
  };
}

describe("ToolCallSink", () => {
  let dir: string;
  let logPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tool-call-sink-"));
    logPath = join(dir, "mcp-tool-calls.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("buffers synchronously and does NOT touch disk on record() — the non-blocking guarantee", () => {
    const sink = new ToolCallSink({ path: logPath, autoFlush: false });
    sink.record(ev());
    // Event is buffered; the durable log must not exist yet (record never wrote).
    expect(sink.pending()).toHaveLength(1);
    expect(existsSync(logPath)).toBe(false);
  });

  it("record() returns void (never a promise) so the call path can't await it", () => {
    const sink = new ToolCallSink({ path: logPath, autoFlush: false });
    const ret = sink.record(ev());
    expect(ret).toBeUndefined();
  });

  it("flush() drains the buffer into a tamper-evident chain — one record per event", () => {
    const sink = new ToolCallSink({ path: logPath, autoFlush: false });
    sink.record(ev({ tool: "a" }));
    sink.record(ev({ tool: "b" }));
    sink.record(ev({ tool: "c", status: "error", error: "boom" }));
    expect(sink.pending()).toHaveLength(3);

    sink.flush();
    expect(sink.pending()).toHaveLength(0);

    // Re-read independently and verify the hash chain holds.
    const reread = new AuditLog(logPath);
    const recs = reread.all();
    expect(recs).toHaveLength(3);
    expect(reread.verifyChain().ok).toBe(true);
    expect(recs.every((r) => r.event === "mcp.tool_call")).toBe(true);
    expect(recs[0]?.subject).toBe("alpha");
    expect(recs[2]?.detail).toMatchObject({ tool: "c", status: "error", error: "boom" });
    // args are never stored raw — only the hash rides in detail.
    const raw = readFileSync(logPath, "utf8");
    expect(raw).not.toContain('"args"');
    expect(recs[0]?.detail).toMatchObject({ args_hash: "deadbeefdeadbeef" });
  });

  it("a disabled sink is a complete no-op", () => {
    const sink = new ToolCallSink({ path: logPath, autoFlush: false });
    sink.setEnabled(false);
    sink.record(ev());
    expect(sink.pending()).toHaveLength(0);
    sink.flush();
    expect(existsSync(logPath)).toBe(false);
  });

  it("preserves the call's own ts as event_ts (not the later flush time)", () => {
    const sink = new ToolCallSink({ path: logPath, autoFlush: false });
    sink.record(ev({ ts: "2020-01-01T00:00:00.000Z" }));
    sink.flush();
    const recs = new AuditLog(logPath).all();
    expect(recs[0]?.detail).toMatchObject({ event_ts: "2020-01-01T00:00:00.000Z" });
    // The chain ts (flush time) differs from the call ts.
    expect(recs[0]?.ts).not.toBe("2020-01-01T00:00:00.000Z");
  });
});
