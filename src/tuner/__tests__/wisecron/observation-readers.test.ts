import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeMcpToolCallReader,
  makeModeDispatchReader,
} from "../../wisecron/observation-readers.js";
import { McpPluginSubject } from "../../subjects/mcp-plugin-subject.js";
import { ModelRoutingSubject } from "../../subjects/model-routing-subject.js";

const SINCE = new Date("2026-05-20T00:00:00Z");
const IN_TS = "2026-05-21T12:00:00.000Z";
const OLD_TS = "2026-05-01T12:00:00.000Z";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "obs-readers-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("makeMcpToolCallReader", () => {
  it("maps hash-chained mcp.tool_call entries to the subject event shape", () => {
    const path = join(dir, "mcp-tool-calls.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          seq: 1,
          ts: IN_TS,
          event: "mcp.tool_call",
          subject: "gws-gmail",
          detail: { tool: "gmail_list_unread", status: "ok", duration_ms: 12 },
        }),
        JSON.stringify({
          seq: 2,
          ts: IN_TS,
          event: "mcp.tool_call",
          subject: "gws-gmail",
          detail: { tool: "gmail_send", status: "blocked" },
        }),
        // non-tool-call event on the same chain → ignored
        JSON.stringify({ seq: 3, ts: IN_TS, event: "audit.something", subject: "x" }),
      ].join("\n"),
    );
    const reader = makeMcpToolCallReader(path);
    const events = reader("ignored-legacy-path", SINCE);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "mcp_tool_call",
      server: "gws-gmail",
      tool: "gmail_list_unread",
      success: true,
      blocked: false,
    });
    expect(events[1]).toMatchObject({ tool: "gmail_send", success: false, blocked: true });
  });

  it("filters entries older than `since` and tolerates a missing file", () => {
    const path = join(dir, "mcp-tool-calls.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: OLD_TS, event: "mcp.tool_call", subject: "s", detail: { tool: "t", status: "ok" } }),
        JSON.stringify({ ts: IN_TS, event: "mcp.tool_call", subject: "s", detail: { tool: "t", status: "ok" } }),
      ].join("\n"),
    );
    expect(makeMcpToolCallReader(path)("x", SINCE)).toHaveLength(1);
    expect(makeMcpToolCallReader(join(dir, "nope.jsonl"))("x", SINCE)).toEqual([]);
  });

  it("feeds McpPluginSubject.collectObservations so obs > 0 (the bug it fixes)", async () => {
    const path = join(dir, "mcp-tool-calls.jsonl");
    writeFileSync(
      path,
      JSON.stringify({
        ts: IN_TS,
        event: "mcp.tool_call",
        subject: "gws-gmail",
        detail: { tool: "gmail_send", status: "blocked" },
      }),
    );
    const subject = new McpPluginSubject({ auditReader: makeMcpToolCallReader(path) });
    const obs = await subject.collectObservations(SINCE);
    expect(obs.length).toBeGreaterThan(0);
  });
});

describe("makeModeDispatchReader", () => {
  it("maps mode_dispatch journal lines to the mode_dispatched event shape", () => {
    const path = join(dir, "mode_dispatch.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: IN_TS, mode: "chat", matched_keyword: "non", reclassified: false }),
        JSON.stringify({ ts: IN_TS, mode: "implementation", matched_keyword: "implement", reclassified: true }),
        JSON.stringify({ ts: OLD_TS, mode: "chat", matched_keyword: "old", reclassified: false }),
      ].join("\n"),
    );
    const events = makeModeDispatchReader(path)(SINCE);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "mode_dispatched",
      mode: "chat",
      keyword: "non",
      reclassified: false,
    });
    expect(events[1]).toMatchObject({ mode: "implementation", keyword: "implement", reclassified: true });
  });

  it("feeds ModelRoutingSubject.collectObservations so obs > 0", async () => {
    const path = join(dir, "mode_dispatch.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: IN_TS, mode: "chat", matched_keyword: "non", reclassified: true }),
        JSON.stringify({ ts: IN_TS, mode: "chat", matched_keyword: "non", reclassified: false }),
      ].join("\n"),
    );
    const subject = new ModelRoutingSubject({ dispatchReader: makeModeDispatchReader(path) });
    const obs = await subject.collectObservations(SINCE);
    expect(obs.length).toBeGreaterThan(0);
  });

  it("returns [] for a missing journal", () => {
    expect(makeModeDispatchReader(join(dir, "nope.jsonl"))(SINCE)).toEqual([]);
  });
});
