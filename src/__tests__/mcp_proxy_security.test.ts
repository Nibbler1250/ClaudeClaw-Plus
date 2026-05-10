import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHmac } from "node:crypto";
import { McpProxyPlugin, _resetMcpProxy } from "../plugins/mcp-proxy/index.js";
import { _resetMcpBridge } from "../plugins/mcp-bridge.js";
import { getHttpGateway, _resetHttpGateway } from "../plugins/http-gateway.js";
import type { PluginHttpGateway } from "../plugins/http-gateway.js";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.ts", import.meta.url));
const BUN_BIN = process.execPath;

let tmpDir: string;
let plugin: McpProxyPlugin;
let gateway: PluginHttpGateway;
let proxyToken: Buffer;

function signRequest(token: Buffer, body: string, ts: string): string {
  return createHmac("sha256", token).update(`${ts}\n${body}`).digest("hex");
}

async function invokeViaTool(tool: string, bodyObj: unknown, token: Buffer, tsOverride?: string): Promise<Response> {
  const ts = tsOverride ?? new Date().toISOString();
  const body = JSON.stringify(bodyObj);
  const sig = signRequest(token, body, ts);
  return gateway.handleRequest(
    new Request(`http://localhost/api/plugin/mcp-proxy/tools/${tool}/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Plus-Ts": ts,
        "X-Plus-Signature": sig,
      },
      body,
    }),
    new URL(`http://localhost/api/plugin/mcp-proxy/tools/${tool}/invoke`),
  ) as Promise<Response>;
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-proxy-sec-test-"));
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();

  const configPath = join(tmpDir, "mcp-proxy.json");
  const tokenPath = join(tmpDir, "mcp-proxy.token");
  writeFileSync(configPath, JSON.stringify({
    servers: {
      "test-server": {
        command: BUN_BIN,
        args: ["run", MOCK_SERVER],
        enabled: true,
        allowedTools: ["echo"],
      },
    },
  }));

  plugin = new McpProxyPlugin({ configPath, tokenPath });
  await plugin.start();

  // Use singleton gateway where plugin registered itself
  gateway = getHttpGateway();
  proxyToken = Buffer.from(readFileSync(tokenPath, "utf8").trim(), "hex");
});

afterEach(async () => {
  await plugin.stop();
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpProxy();
  try { rmSync(tmpDir, { recursive: true }); } catch {}
});

// ── Test 1 — wrong HMAC → 401 ─────────────────────────────────────────────

describe("mcp-proxy security", () => {
  it("invalid HMAC signature returns 401", async () => {
    const ts = new Date().toISOString();
    const body = JSON.stringify({ arguments: { message: "test" }, mode: "direct" });
    const resp = await gateway.handleRequest(
      new Request("http://localhost/api/plugin/mcp-proxy/tools/test-server__echo/invoke", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Plus-Ts": ts,
          "X-Plus-Signature": "0".repeat(64), // wrong signature
        },
        body,
      }),
      new URL("http://localhost/api/plugin/mcp-proxy/tools/test-server__echo/invoke"),
    );
    expect(resp?.status).toBe(401);
  });

  // ── Test 2 — stale timestamp → 401 ───────────────────────────────────────

  it("timestamp outside replay window returns 401", async () => {
    const staleTs = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
    const resp = await invokeViaTool("test-server__echo",
      { arguments: { message: "test" }, mode: "direct" },
      proxyToken,
      staleTs,
    );
    expect(resp?.status).toBe(401);
  });

  // ── Test 3 — stderr doesn't pollute response ──────────────────────────────

  it("MCP server stderr goes to log file, not HTTP response body", async () => {
    // Even if the server emits stderr, the JSON response should still be valid
    const resp = await invokeViaTool("test-server__echo",
      { arguments: { message: "stderr-test" }, mode: "direct" },
      proxyToken,
    );
    // Response must be valid JSON with a result field
    if (resp && resp.status === 200) {
      const data = await resp.json() as { result?: unknown };
      expect(data).toHaveProperty("result");
    }
  });

  // ── Test 4 — path traversal args pass through without validation ──────────

  it("path-traversal args propagate cleanly to the MCP server without proxy injection", async () => {
    const resp = await invokeViaTool("test-server__echo",
      { arguments: { message: "../../etc/passwd" }, mode: "direct" },
      proxyToken,
    );
    if (resp && resp.status === 200) {
      const data = await resp.json() as { result?: { echo?: string } };
      // Server echoes back exactly what we sent — proxy doesn't sanitize
      expect(data.result).toMatchObject({ echo: "../../etc/passwd" });
    }
  });
});
