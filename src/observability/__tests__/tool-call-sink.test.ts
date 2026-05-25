import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../../skills-tuner/core/audit-log.js";
import { ToolCallSink } from "../tool-call-sink.js";
import { McpToolCallTelemetryProducer } from "../mcp-tool-call-producer.js";
import type { ToolCallEvent, ToolCallIntent } from "../tool-call.js";

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

function intent(over: Partial<ToolCallIntent> = {}): ToolCallIntent {
  return {
    ts: "2026-05-25T12:00:00.000Z",
    plugin: "alpha",
    tool: "echo",
    agent_id: "pty-1",
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

describe("ToolCallSink — mandatory-audit policy", () => {
  let dir: string;
  let logPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tool-call-policy-"));
    logPath = join(dir, "mcp-tool-calls.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("defaults to best-effort; setPolicy/getPolicy round-trips", () => {
    const sink = new ToolCallSink({ path: logPath, autoFlush: false });
    expect(sink.getPolicy()).toBe("best-effort");
    sink.setPolicy("enforce");
    expect(sink.getPolicy()).toBe("enforce");
  });

  it("enforce: recordIntent is a SYNCHRONOUS local append — durable on disk the instant it returns (no flush, no await)", () => {
    const sink = new ToolCallSink({ path: logPath, policy: "enforce", autoFlush: false });
    // No buffering, no timer: the write must already be on disk when the
    // synchronous call returns. This is the "on the call path, local append"
    // property — there is no async/network step between the call and the write.
    const ret = sink.recordIntent(intent());
    expect(ret).toBeUndefined();
    expect(existsSync(logPath)).toBe(true);
    // And it was never buffered (the result-log machinery is untouched).
    expect(sink.pending()).toHaveLength(0);

    const recs = new AuditLog(logPath).all();
    expect(recs).toHaveLength(1);
    expect(recs[0]?.event).toBe("mcp.tool_call_intent");
    expect(recs[0]?.subject).toBe("alpha");
    expect(recs[0]?.detail).toMatchObject({
      tool: "echo",
      agent_id: "pty-1",
      args_hash: "deadbeefdeadbeef",
      event_ts: "2026-05-25T12:00:00.000Z",
    });
    // Intent has no status/duration — the call hadn't run when it was recorded.
    expect(recs[0]?.detail).not.toHaveProperty("status");
    expect(recs[0]?.detail).not.toHaveProperty("duration_ms");
  });

  it("enforce: a failing intent append THROWS (so the caller can fail closed)", () => {
    const boom = new Error("disk full");
    const sink = new ToolCallSink({
      path: logPath,
      policy: "enforce",
      autoFlush: false,
      logFactory: () => ({
        append() {
          throw boom;
        },
      }),
    });
    expect(() => sink.recordIntent(intent())).toThrow("disk full");
    // Nothing was written and nothing leaked into the result buffer.
    expect(existsSync(logPath)).toBe(false);
    expect(sink.pending()).toHaveLength(0);
  });

  it("best-effort: recordIntent is a no-op — no write, no buffer, never throws (current behaviour preserved)", () => {
    // Even with a chain that WOULD throw, best-effort never calls it.
    const sink = new ToolCallSink({
      path: logPath,
      policy: "best-effort",
      autoFlush: false,
      logFactory: () => ({
        append() {
          throw new Error("must never be called under best-effort");
        },
      }),
    });
    expect(() => sink.recordIntent(intent())).not.toThrow();
    expect(existsSync(logPath)).toBe(false);
    expect(sink.pending()).toHaveLength(0);
  });

  it("enforce: intent gate is independent of the observability-capture flag (a hard guarantee, not a metric)", () => {
    const sink = new ToolCallSink({ path: logPath, policy: "enforce", autoFlush: false });
    sink.setEnabled(false); // disables Phase-2 result capture...
    sink.recordIntent(intent()); // ...but the Phase-1 gate still records.
    expect(existsSync(logPath)).toBe(true);
    expect(new AuditLog(logPath).all()).toHaveLength(1);
  });

  it("recordPolicy: enforce writes an mcp.audit_policy boot record; best-effort writes nothing", () => {
    const beSink = new ToolCallSink({ path: logPath, policy: "best-effort", autoFlush: false });
    beSink.recordPolicy();
    expect(existsSync(logPath)).toBe(false); // best-effort stays write-free at boot

    const enfSink = new ToolCallSink({ path: logPath, policy: "enforce", autoFlush: false });
    enfSink.recordPolicy();
    const recs = new AuditLog(logPath).all();
    expect(recs).toHaveLength(1);
    expect(recs[0]?.event).toBe("mcp.audit_policy");
    expect(recs[0]?.detail).toMatchObject({ policy: "enforce" });
  });

  it("recordPolicy swallows its own write failure (boot must never crash on it)", () => {
    const sink = new ToolCallSink({
      path: logPath,
      policy: "enforce",
      autoFlush: false,
      logFactory: () => ({
        append() {
          throw new Error("disk full");
        },
      }),
    });
    expect(() => sink.recordPolicy()).not.toThrow();
  });

  it("intent + result share one chain and the hash chain stays valid across both write paths", () => {
    const sink = new ToolCallSink({ path: logPath, policy: "enforce", autoFlush: false });
    sink.recordIntent(intent({ tool: "echo" })); // synchronous
    sink.record(ev({ tool: "echo" })); // buffered
    sink.flush(); // drains the result onto the SAME chain
    const reread = new AuditLog(logPath);
    const recs = reread.all();
    expect(recs).toHaveLength(2);
    expect(recs[0]?.event).toBe("mcp.tool_call_intent");
    expect(recs[1]?.event).toBe("mcp.tool_call");
    // The chain links intent → result without breaking.
    expect(reread.verifyChain().ok).toBe(true);
  });

  it("intent records do NOT pollute the metrics producer (it counts only mcp.tool_call)", async () => {
    const sink = new ToolCallSink({ path: logPath, policy: "enforce", autoFlush: false });
    const nowIso = new Date().toISOString();
    sink.recordIntent(intent({ tool: "echo", ts: nowIso }));
    sink.record(ev({ tool: "echo", ts: nowIso }));
    sink.flush();
    const producer = new McpToolCallTelemetryProducer({ logPath });
    const samples = await producer.query("mcp.tool_call", {
      start: new Date(Date.now() - 60_000),
      end: new Date(Date.now() + 60_000),
    });
    // Two records on the chain (1 intent + 1 result) but the producer yields
    // exactly ONE sample — the intent is filtered out by event name.
    expect(samples).toHaveLength(1);
    expect(samples[0]?.labels.tool).toBe("echo");
    expect(samples[0]?.labels.status).toBe("ok");
  });
});
