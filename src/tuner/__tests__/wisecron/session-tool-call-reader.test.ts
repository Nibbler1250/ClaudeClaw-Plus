import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSessionToolCallReader } from "../../wisecron/observation-readers.js";
import { McpPluginSubject } from "../../subjects/mcp-plugin-subject.js";

let root: string;
let projectsDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sess-reader-"));
  projectsDir = join(root, "projects");
  mkdirSync(projectsDir, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a session transcript: assistant tool_use blocks + a user tool_result. */
function writeSession(name: string, isoTs: string): void {
  const dir = join(projectsDir, "-home-x-proj");
  mkdirSync(dir, { recursive: true });
  const lines = [
    {
      type: "assistant",
      timestamp: isoTs,
      message: {
        content: [
          { type: "tool_use", id: "t1", name: "mcp__gws-gmail__gmail_list_unread", input: {} },
          { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/home/x/notes.txt" } },
          { type: "tool_use", id: "t3", name: "mcp__gws-gmail__gmail_send", input: {} },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t3", is_error: true, content: "boom" }],
      },
    },
  ];
  writeFileSync(join(dir, name), lines.map((l) => JSON.stringify(l)).join("\n"));
}

const SINCE = new Date("2026-06-01T00:00:00Z");

describe("makeSessionToolCallReader", () => {
  it("maps mcp__ tool_use blocks to the mcp_tool_call shape, dropping bare tools", () => {
    writeSession("s1.jsonl", "2026-06-05T12:00:00.000Z");
    const reader = makeSessionToolCallReader({ projectsDir });
    const events = reader("ignored", SINCE);

    // Read (bare harness tool) is dropped; only the 2 mcp__ calls remain.
    expect(events.length).toBe(2);
    for (const e of events) {
      expect(e.type).toBe("mcp_tool_call");
      expect(e.server).toBe("gws-gmail");
    }
    const send = events.find((e) => e.tool === "gmail_send");
    const list = events.find((e) => e.tool === "gmail_list_unread");
    // t3 had an is_error tool_result → success false; t1 had none → success true.
    expect(send?.success).toBe(false);
    expect(list?.success).toBe(true);
  });

  it("excludes events whose assistant timestamp predates `since`", () => {
    writeSession("old.jsonl", "2026-05-01T12:00:00.000Z"); // before SINCE
    const reader = makeSessionToolCallReader({ projectsDir });
    expect(reader("ignored", SINCE).length).toBe(0);
  });

  it("returns [] when the projects dir is absent", () => {
    const reader = makeSessionToolCallReader({ projectsDir: join(root, "nope") });
    expect(reader("ignored", SINCE)).toEqual([]);
  });

  it("feeds McpPluginSubject.collectObservations → obs>0 (one per server::tool)", async () => {
    writeSession("s1.jsonl", "2026-06-05T12:00:00.000Z");
    const subject = new McpPluginSubject({
      auditReader: makeSessionToolCallReader({ projectsDir }),
    });
    const obs = await subject.collectObservations(SINCE);
    // Two distinct tools on one server → two observations.
    expect(obs.length).toBe(2);
    const servers = new Set(obs.map((o) => (o.metadata as Record<string, unknown>).server));
    expect(servers).toEqual(new Set(["gws-gmail"]));
  });
});
