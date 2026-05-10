/**
 * MCP serve smoke tests:
 * - tools/list returns 9 skills-tuner tools with correct names and schemas
 * - stdout discipline: no garbage bytes prefix/suffix on the JSON-RPC stream
 */

import { describe, it, expect } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..", "..");

const EXPECTED_TOOLS = [
  "skills-tuner__tuner_pending",
  "skills-tuner__tuner_cron_run",
  "skills-tuner__tuner_apply",
  "skills-tuner__tuner_skip",
  "skills-tuner__tuner_revert",
  "skills-tuner__tuner_feedback",
  "skills-tuner__tuner_stats",
  "skills-tuner__tuner_doctor",
  "skills-tuner__tuner_setup",
];

// MCP stdio transport uses newline-delimited JSON (not Content-Length headers)
function mcpRequest(method: string, params: unknown = {}): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n";
}

async function runMcpListTools(): Promise<{ rawStdout: string; parsed: unknown }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", ["run", join(SRC_ROOT, "src", "index.ts"), "mcp-serve"], {
      env: {
        ...process.env,
        TUNER_AUDIT_PATH: "/tmp/tuner-audit-mcp-test.jsonl",
      },
    });

    let rawStdout = "";
    let settled = false;

    proc.stdout.on("data", (chunk: Buffer) => {
      rawStdout += chunk.toString("utf8");
      // Each MCP response is one JSON line
      const lines = rawStdout.split("\n").filter((l) => l.trim().startsWith("{"));
      if (lines.length > 0 && !settled) {
        settled = true;
        proc.kill();
        try {
          const parsed = JSON.parse(lines[0]!);
          resolve({ rawStdout, parsed });
        } catch (e) {
          reject(new Error(`Failed to parse MCP response: ${e}\nRaw: ${rawStdout.slice(0, 500)}`));
        }
      }
    });

    proc.on("error", reject);

    // Send tools/list request after server starts
    setTimeout(() => {
      proc.stdin.write(mcpRequest("tools/list"));
    }, 1200);

    setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error(`Timeout — raw stdout so far: ${rawStdout.slice(0, 300)}`));
      }
    }, 10000);
  });
}

describe("mcp-serve smoke test", () => {
  it("returns exactly 9 skills-tuner tools from tools/list", async () => {
    const { parsed } = await runMcpListTools();
    const result = parsed as { result: { tools: Array<{ name: string }> } };
    expect(result.result).toBeDefined();
    const tools = result.result.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(9);

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
  }, 12000);

  it("stdout contains only valid JSON-RPC lines — no garbage prefix", async () => {
    const { rawStdout } = await runMcpListTools();
    // Every non-empty line must parse as JSON
    for (const line of rawStdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      expect(() => JSON.parse(trimmed)).not.toThrow();
    }
    // First byte of stdout must be '{' (start of JSON), not any logging cruft
    expect(rawStdout.trimStart()[0]).toBe("{");
  }, 12000);

  it("each tool has a valid inputSchema object", async () => {
    const { parsed } = await runMcpListTools();
    const result = parsed as {
      result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    };
    for (const tool of result.result.tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(typeof tool.inputSchema).toBe("object");
      expect(tool.inputSchema.type).toBe("object");
    }
  }, 12000);
});
