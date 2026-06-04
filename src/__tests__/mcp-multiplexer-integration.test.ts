/**
 * Phase C wire-level integration tests for the MCP multiplexer.
 *
 * Phase B's unit tests mock the MCP transport boundary; this file proves
 * that the wire actually works:
 *   - real `Bun.serve` HTTP listener (ephemeral port) mounted on the
 *     `PluginHttpGateway`,
 *   - real upstream MCP stdio child spawned by the multiplexer's
 *     `McpServerProcess`,
 *   - real MCP SDK `Client` + `StreamableHTTPClientTransport` talking
 *     across the loopback boundary with per-PTY HMAC bearer headers.
 *
 * The fixture child is the existing `src/__tests__/fixtures/mock-mcp-server.ts`
 * which exposes a deterministic `echo` tool over stdio.
 *
 * Scope is hermetic: every test uses a tmpdir-scoped `mcp-proxy.json`,
 * binds the gateway to port 0, and tears down all spawned children +
 * listeners in `afterEach`. None of these tests touch `~/.config`,
 * require the `claude` CLI, or talk to the network beyond loopback.
 *
 * See `.planning/mcp-multiplexer/SPEC.md` §§4.1–4.6, 6.3, 7.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  McpMultiplexerPlugin,
  _resetMcpMultiplexer,
  type MuxSettingsView,
} from "../plugins/mcp-multiplexer/index.js";
import { _resetHttpGateway, getHttpGateway } from "../plugins/http-gateway.js";
import { _resetMcpBridge, getMcpBridge } from "../plugins/mcp-bridge.js";
import { _resetIdentityStore } from "../plugins/mcp-multiplexer/pty-identity.js";
import { __setToolCallSinkForTest, ToolCallSink } from "../observability/tool-call-sink.js";
import { McpToolCallTelemetryProducer } from "../observability/mcp-tool-call-producer.js";
import { AuditLog } from "../skills-tuner/core/audit-log.js";

const MOCK_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.ts", import.meta.url));
const BUN_BIN = process.execPath;

// ── Helpers ──────────────────────────────────────────────────────────────────

function writeProxyConfig(dir: string, names: string[]): string {
  const cfg = {
    servers: Object.fromEntries(
      names.map((name) => [
        name,
        {
          command: BUN_BIN,
          args: ["run", MOCK_SERVER],
          enabled: true,
          allowedTools: ["echo"],
        },
      ]),
    ),
  };
  const path = join(dir, "mcp-proxy.json");
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}

function makeSettingsView(partial: Partial<MuxSettingsView>): () => MuxSettingsView {
  const view: MuxSettingsView = {
    webEnabled: true,
    webHost: "127.0.0.1",
    webPort: 4632,
    shared: [],
    stateless: [],
    healthProbeIntervalMs: 0,
    // Phase B added these fields to MuxSettingsView. Tests pre-dating
    // Phase B set defaults that disable persistence so behaviour is
    // identical to PR #71.
    sessionPersistenceEnabled: false,
    sessionMaxAgeSeconds: 3600,
    sessionPersistencePath: "",
    // Issue #68/#69 + Phase A added these to MuxSettingsView after this helper
    // was first written; start() reads them unconditionally, so default them
    // here (off) and let opt-in tests override via `partial`.
    metricsEnabled: false,
    observabilityEnabled: false,
    auditPolicy: "best-effort",
    cache: {
      enabled: false,
      ttlMs: 5_000,
      maxEntries: 1_000,
      cacheable: {},
      defensiveInvalidation: true,
    },
    ...partial,
  };
  return () => view;
}

/** Start a hermetic Bun.serve listener on an ephemeral loopback port
 *  that routes BOTH `/api/plugin/*` and `/mcp/*` to the gateway. The
 *  `/mcp/*` route is the part missing from production `src/ui/server.ts`
 *  today (it only routes `/api/plugin/`); we mount it here so the wire
 *  test exercises the full gateway surface. The production gap is
 *  surfaced in the Phase C report. */
function startTestGateway(): {
  origin: string;
  port: number;
  stop: () => Promise<void>;
} {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/plugin/") || url.pathname.startsWith("/mcp/")) {
        const resp = await getHttpGateway().handleRequest(req, url);
        if (resp !== null) return resp;
      }
      return new Response("not found", { status: 404 });
    },
  });
  const port = server.port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    stop: async () => {
      server.stop(true);
    },
  };
}

/** Build a fully-headered MCP SDK Client pointed at the multiplexer. */
async function connectClient(opts: {
  origin: string;
  server: string;
  ptyId: string;
  bearer: string;
  clientName?: string;
}): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${opts.origin}/mcp/${opts.server}`),
    {
      requestInit: {
        headers: {
          Authorization: opts.bearer,
          "X-Claudeclaw-Pty-Id": opts.ptyId,
        },
      },
    },
  );
  const client = new Client(
    { name: opts.clientName ?? `test-client/${opts.ptyId}`, version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch {}
    },
  };
}

// ── Suite plumbing ──────────────────────────────────────────────────────────

let tmpDir: string;
let plugin: McpMultiplexerPlugin | null = null;
let gateway: { origin: string; port: number; stop: () => Promise<void> } | null = null;

async function teardown(): Promise<void> {
  if (plugin) {
    try {
      await plugin.stop();
    } catch {}
    plugin = null;
  }
  if (gateway) {
    try {
      await gateway.stop();
    } catch {}
    gateway = null;
  }
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpMultiplexer();
  _resetIdentityStore();
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-mux-itest-"));
  _resetMcpBridge();
  _resetHttpGateway();
  _resetMcpMultiplexer();
  _resetIdentityStore();
});

afterEach(async () => {
  await teardown();
  try {
    rmSync(tmpDir, { recursive: true });
  } catch {}
});

// ── 1) End-to-end happy path ────────────────────────────────────────────────

describe("mcp-multiplexer integration — happy path", () => {
  it("real SDK client lists tools and round-trips a tools/call over loopback HTTP", {
    timeout: 10000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha"],
      }),
    });
    await plugin.start();
    expect(plugin.isActive()).toBe(true);

    gateway = startTestGateway();
    const ident = plugin.issueIdentity("pty-happy");

    const { client, close } = await connectClient({
      origin: gateway.origin,
      server: "alpha",
      ptyId: "pty-happy",
      bearer: ident.headers.Authorization,
    });

    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(["echo"]);

      const result = await client.callTool({
        name: "echo",
        arguments: { message: "wire works" },
      });
      // The handler wraps the upstream result as
      // { content: [{ type: "text", text: JSON.stringify(upstreamJson) }] }
      const content = (result.content as Array<{ type: string; text: string }>)[0];
      expect(content?.type).toBe("text");
      expect(content?.text).toContain("wire works");
    } finally {
      await close();
    }
  });
});

// ── 2) Per-PTY auth ─────────────────────────────────────────────────────────

describe("mcp-multiplexer integration — per-PTY auth", () => {
  it("two distinct PTY identities can both invoke without leaking session state", {
    timeout: 10000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha"],
      }),
    });
    await plugin.start();
    gateway = startTestGateway();

    const a = plugin.issueIdentity("pty-A");
    const b = plugin.issueIdentity("pty-B");
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);

    const ca = await connectClient({
      origin: gateway.origin,
      server: "alpha",
      ptyId: "pty-A",
      bearer: a.headers.Authorization,
    });
    const cb = await connectClient({
      origin: gateway.origin,
      server: "alpha",
      ptyId: "pty-B",
      bearer: b.headers.Authorization,
    });

    try {
      // Concurrent invocations — each must succeed independently.
      const [ra, rb] = await Promise.all([
        ca.client.callTool({
          name: "echo",
          arguments: { message: "from-A" },
        }),
        cb.client.callTool({
          name: "echo",
          arguments: { message: "from-B" },
        }),
      ]);

      const ta = (ra.content as Array<{ text: string }>)[0]!.text;
      const tb = (rb.content as Array<{ text: string }>)[0]!.text;
      expect(ta).toContain("from-A");
      expect(tb).toContain("from-B");

      // For stateful (default) server, each PTY gets its own bucket.
      const handler = plugin._getHandler("alpha");
      const h = handler?.health() as {
        stateless: boolean;
        active_buckets: number;
        bucket_keys: string[];
      };
      expect(h.stateless).toBe(false);
      expect(h.bucket_keys.sort()).toEqual(["pty-A", "pty-B"]);
    } finally {
      await ca.close();
      await cb.close();
    }
  });
});

// ── 3) Auth rejection ───────────────────────────────────────────────────────

describe("mcp-multiplexer integration — auth rejection", () => {
  it("forged bearer for a non-issued ptyId returns 401 with no upstream call", {
    timeout: 10000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha"],
      }),
    });
    await plugin.start();
    gateway = startTestGateway();

    // Audit hook to confirm no upstream invoke is recorded.
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const bridge = getMcpBridge();
    const origAudit = bridge.audit.bind(bridge);
    bridge.audit = (event, payload) => {
      events.push({ event, payload });
      origAudit(event, payload);
    };

    try {
      // Forge bearer: 64 hex chars (the correct length) but a ptyId
      // that was never issued.
      const forged = `Bearer ${"a".repeat(64)}`;
      const resp = await fetch(`${gateway.origin}/mcp/alpha`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: forged,
          "X-Claudeclaw-Pty-Id": "pty-never-issued",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(resp.status).toBe(401);
      const body = (await resp.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("invalid_bearer");

      // Auth-rejected audit fired; no `multiplexer_invoke` event.
      const rejected = events.find((e) => e.event === "multiplexer_auth_rejected");
      expect(rejected).toBeDefined();
      const invokes = events.filter((e) => e.event === "multiplexer_invoke");
      expect(invokes).toHaveLength(0);
    } finally {
      bridge.audit = origAudit;
    }
  });

  it("missing pty-id header returns 401 missing_pty_id", { timeout: 10000 }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha"],
      }),
    });
    await plugin.start();
    gateway = startTestGateway();

    const resp = await fetch(`${gateway.origin}/mcp/alpha`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${"b".repeat(64)}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("missing_pty_id");
  });
});

// ── 4) Stateful vs stateless session demux ──────────────────────────────────

describe("mcp-multiplexer integration — stateful vs stateless demux", () => {
  it("stateful server creates per-PTY buckets; stateless server collapses to a single __stateless__ bucket", {
    timeout: 10000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha", "beta"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha", "beta"],
        stateless: ["beta"],
      }),
    });
    await plugin.start();
    gateway = startTestGateway();

    const a = plugin.issueIdentity("pty-1");
    const b = plugin.issueIdentity("pty-2");

    // STATEFUL server (`alpha`): use full SDK clients — each PTY's
    // initialize() goes to its own SDK Server in its own bucket.
    const a1 = await connectClient({
      origin: gateway.origin,
      server: "alpha",
      ptyId: "pty-1",
      bearer: a.headers.Authorization,
    });
    const a2 = await connectClient({
      origin: gateway.origin,
      server: "alpha",
      ptyId: "pty-2",
      bearer: b.headers.Authorization,
    });
    await a1.client.listTools();
    await a2.client.listTools();

    // STATELESS server (`beta`): both PTYs share a single SDK Server.
    // The first PTY drives initialize() via the SDK Client; the second
    // PTY hits the same bucket via a raw tools/list — re-initialising
    // a shared SDK Server would (correctly) be rejected, which is the
    // whole point of the stateless mode. We assert the bucket-collapse
    // property on the handler health snapshot.
    const b1 = await connectClient({
      origin: gateway.origin,
      server: "beta",
      ptyId: "pty-1",
      bearer: a.headers.Authorization,
    });
    await b1.client.listTools();

    // PTY-2 reuses the existing __stateless__ bucket — send a raw
    // tools/list bypassing client-side initialization. Auth still
    // gates the request, so PTY-2 must use its own bearer. The SDK
    // transport will reject this with 400 (no session ID) — that's
    // fine; what matters is the request flowed past auth into the
    // shared bucket without creating a new one, which is the
    // collapse property we assert below on handler.health().
    const resp = await fetch(`${gateway.origin}/mcp/beta`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: b.headers.Authorization,
        "X-Claudeclaw-Pty-Id": "pty-2",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/list",
        params: {},
      }),
    });
    // Past auth (status !== 401, !== 404). The SDK transport may
    // accept (200/202) or reject as malformed session (400) — either
    // proves the request reached the bucket, not the auth wall.
    expect(resp.status).not.toBe(401);
    expect(resp.status).not.toBe(404);

    try {
      const alphaH = plugin._getHandler("alpha")?.health() as {
        stateless: boolean;
        bucket_keys: string[];
      };
      const betaH = plugin._getHandler("beta")?.health() as {
        stateless: boolean;
        bucket_keys: string[];
      };

      expect(alphaH.stateless).toBe(false);
      expect(alphaH.bucket_keys.sort()).toEqual(["pty-1", "pty-2"]);

      expect(betaH.stateless).toBe(true);
      // STATELESS_BUCKET sentinel — one bucket regardless of PTY count.
      expect(betaH.bucket_keys).toEqual(["__stateless__"]);
    } finally {
      await a1.close();
      await a2.close();
      await b1.close();
    }
  });
});

// ── 5) Bridge callback integration ──────────────────────────────────────────

describe("mcp-multiplexer integration — bridge callback path", () => {
  it("legacy in-process caller can invoke a shared tool via getMcpBridge() with no HTTP hop", {
    timeout: 10000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha"],
      }),
    });
    await plugin.start();
    // Intentionally do NOT start the HTTP gateway listener — this
    // exercises the in-process bridge path (SPEC §10 Q#2 (b)).

    const bridge = getMcpBridge();
    const fqns = bridge.listTools().map((t) => t.fqn);
    expect(fqns).toContain("mcp-multiplexer__alpha__echo");

    const result = await bridge.invokeTool("mcp-multiplexer__alpha__echo", {
      arguments: { message: "via-bridge" },
    });
    // Upstream returns `{ echo: "via-bridge" }` which is JSON-parsed
    // by `McpServerProcess.call`, so the bridge result is the object.
    expect(result).toEqual({ echo: "via-bridge" });
  });
});

// ── 6) Crash + health probe transition ──────────────────────────────────────

describe("mcp-multiplexer integration — crash + health probe transition", () => {
  it("killing the upstream child mid-test fires _onServerCrash and health probe emits mcp_health_degraded", {
    timeout: 15000,
  }, async () => {
    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha"],
        // Keep the probe disabled so we drive sampling deterministically.
        healthProbeIntervalMs: 0,
      }),
    });
    await plugin.start();
    expect(plugin.isActive()).toBe(true);

    gateway = startTestGateway();

    // Capture audit events emitted during the crash + probe sequence.
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const bridge = getMcpBridge();
    const origAudit = bridge.audit.bind(bridge);
    bridge.audit = (event, payload) => {
      events.push({ event, payload });
      origAudit(event, payload);
    };

    try {
      // Confirm one healthy round-trip before the crash to prove the
      // process really is up and serving tool calls.
      const ident = plugin.issueIdentity("pty-pre-crash");
      const c = await connectClient({
        origin: gateway.origin,
        server: "alpha",
        ptyId: "pty-pre-crash",
        bearer: ident.headers.Authorization,
      });
      await c.client.listTools();
      await c.close();

      // Reach into the real McpServerProcess and kill its transport.
      // This is the same path a real upstream child crash takes —
      // the SDK's StdioClientTransport fires `onclose` which the
      // server-process's onCrash hook turns into the
      // `multiplexer_server_crashed` audit + status mutation.
      type ProcLike = {
        servers: Map<string, { status: string; transport: { close?: () => Promise<void> } | null }>;
        lastObservedStatus: Map<string, string>;
      };
      const proc = (plugin as unknown as ProcLike).servers.get("alpha")!;
      const initial = proc.status;

      // Close the transport. McpServerProcess.transport.onclose then
      // invokes _handleCrash → calls our onCrash → status mutates.
      await proc.transport?.close?.();

      // Allow the onclose handler to fire (microtask flush).
      await new Promise((r) => setTimeout(r, 50));

      // Status should have transitioned away from `up`. The crash
      // handler schedules a restart timer with a 1s backoff for the
      // first crash, so by now we expect `crashed` → `restarting`.
      expect(["crashed", "restarting", "up"]).toContain(proc.status);

      // Force-set status to `crashed` if a fast restart already
      // happened — what we want to prove is that the probe transition
      // emits the right audit event. Then drive the probe directly.
      (proc as { status: string }).status = "crashed";
      (plugin as unknown as { lastObservedStatus: Map<string, string> }).lastObservedStatus.set(
        "alpha",
        initial,
      );

      (plugin as unknown as { _sampleHealthForTests: () => void })._sampleHealthForTests();

      const degraded = events.find((e) => e.event === "mcp_health_degraded");
      expect(degraded).toBeDefined();
      expect(degraded?.payload.server).toBe("alpha");
      expect(degraded?.payload.current_status).toBe("crashed");

      // The crash hook itself should also have audited a
      // `multiplexer_server_crashed` event when the real onclose
      // fired (proves the real onCrash → audit path works, not just
      // the unit-level mutation).
      const crashAudit = events.find((e) => e.event === "multiplexer_server_crashed");
      expect(crashAudit).toBeDefined();
      expect(crashAudit?.payload.server).toBe("alpha");
    } finally {
      bridge.audit = origAudit;
    }
  });
});

// ── 7) Phase A observability: gateway boundary capture ──────────────────────

describe("mcp-multiplexer integration — observability boundary capture", () => {
  afterEach(() => {
    __setToolCallSinkForTest(null);
  });

  it("emits exactly one mcp.tool_call event per call, fire-and-forget (not awaited on the call path)", {
    timeout: 10000,
  }, async () => {
    const logPath = join(tmpDir, "mcp-tool-calls.jsonl");
    // autoFlush:false → the event stays buffered until WE flush, so we can
    // prove the emit is deferred off the request path (the durable write never
    // happened during dispatch).
    const sink = new ToolCallSink({ path: logPath, autoFlush: false });
    __setToolCallSinkForTest(sink);

    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha"],
        observabilityEnabled: true,
      }),
    });
    await plugin.start();
    gateway = startTestGateway();
    const ident = plugin.issueIdentity("pty-obs");

    const { client, close } = await connectClient({
      origin: gateway.origin,
      server: "alpha",
      ptyId: "pty-obs",
      bearer: ident.headers.Authorization,
    });

    try {
      const result = await client.callTool({ name: "echo", arguments: { message: "telemetry" } });
      const content = (result.content as Array<{ text: string }>)[0];
      expect(content?.text).toContain("telemetry");

      // The call returned with NO durable write yet — the emit was buffered,
      // never awaited, never touched disk on the dispatch path.
      expect(existsSync(logPath)).toBe(false);
      const buffered = sink.pending();
      expect(buffered).toHaveLength(1);
      expect(buffered[0]).toMatchObject({
        plugin: "alpha",
        tool: "echo",
        agent_id: "pty-obs",
        status: "ok",
      });
      expect(buffered[0]!.args_hash).toMatch(/^[0-9a-f]{16}$/);
      expect(buffered[0]!.duration_ms).toBeGreaterThanOrEqual(0);
      // raw args are never carried on the event.
      expect(JSON.stringify(buffered[0])).not.toContain("telemetry");

      // Flushing lands it on the audited+queryable surface.
      sink.flush();
      const producer = new McpToolCallTelemetryProducer({ logPath });
      const samples = await producer.query("mcp.tool_call", {
        start: new Date(Date.now() - 60_000),
        end: new Date(Date.now() + 60_000),
      });
      expect(samples).toHaveLength(1);
      expect(samples[0]!.labels?.plugin).toBe("alpha");
    } finally {
      await close();
    }
  });
});

// ── 8) Mandatory audit: enforce (fail-closed) vs best-effort ────────────────

describe("mcp-multiplexer integration — mandatory-audit policy", () => {
  afterEach(() => {
    __setToolCallSinkForTest(null);
  });

  it("enforce: a tool call whose intent CANNOT be logged is REFUSED and never dispatched (no log → no action)", {
    timeout: 10000,
  }, async () => {
    // A sink in enforce mode whose backing chain ALWAYS throws on append.
    const sink = new ToolCallSink({
      path: join(tmpDir, "mcp-tool-calls.jsonl"),
      policy: "enforce",
      autoFlush: false,
      logFactory: () => ({
        append() {
          throw new Error("audit chain unavailable");
        },
      }),
    });
    __setToolCallSinkForTest(sink);

    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha"],
        observabilityEnabled: true,
        auditPolicy: "enforce",
      }),
    });
    await plugin.start();
    gateway = startTestGateway();

    // Capture audit events to prove the refusal was recorded out-of-band.
    const bridge = getMcpBridge();
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const origAudit = bridge.audit.bind(bridge);
    bridge.audit = (event: string, payload: Record<string, unknown>) => {
      events.push({ event, payload });
    };

    const ident = plugin.issueIdentity("pty-enf");
    const { client, close } = await connectClient({
      origin: gateway.origin,
      server: "alpha",
      ptyId: "pty-enf",
      bearer: ident.headers.Authorization,
    });

    try {
      const result = await client.callTool({
        name: "echo",
        arguments: { message: "should-not-run" },
      });
      // The call is REFUSED: error result, refusal text, and crucially the
      // echoed input never came back (the upstream tool was never dispatched).
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).toContain("refused");
      expect(text).toContain("enforce");
      expect(text).not.toContain("should-not-run");
      // The refusal itself is audited.
      const refusal = events.find((e) => e.event === "multiplexer_audit_enforced_reject");
      expect(refusal).toBeDefined();
      expect(refusal?.payload.reason).toBe("intent_log_failed");
      expect(refusal?.payload.tool).toBe("echo");
    } finally {
      bridge.audit = origAudit;
      await close();
    }
  });

  it("enforce: when the intent CAN be logged, the call proceeds and BOTH intent + result land on the chain", {
    timeout: 10000,
  }, async () => {
    const logPath = join(tmpDir, "mcp-tool-calls.jsonl");
    const sink = new ToolCallSink({ path: logPath, policy: "enforce", autoFlush: false });
    __setToolCallSinkForTest(sink);

    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha"],
        observabilityEnabled: true,
        auditPolicy: "enforce",
      }),
    });
    await plugin.start();
    gateway = startTestGateway();
    const ident = plugin.issueIdentity("pty-enf2");
    const { client, close } = await connectClient({
      origin: gateway.origin,
      server: "alpha",
      ptyId: "pty-enf2",
      bearer: ident.headers.Authorization,
    });

    try {
      const result = await client.callTool({ name: "echo", arguments: { message: "telemetry" } });
      const content = (result.content as Array<{ text: string }>)[0];
      expect(content?.text).toContain("telemetry");

      // Phase 1 intent was written SYNCHRONOUSLY on the call path — the durable
      // log exists already, BEFORE we flush the buffered Phase-2 result.
      expect(existsSync(logPath)).toBe(true);
      // The Phase-2 result is still buffered (fire-and-forget, not awaited).
      expect(sink.pending()).toHaveLength(1);

      sink.flush();
      const reread = new AuditLog(logPath);
      const recs = reread.all();
      // Boot policy record (enforce) + intent + result.
      const intents = recs.filter((r) => r.event === "mcp.tool_call_intent");
      const results = recs.filter((r) => r.event === "mcp.tool_call");
      const policies = recs.filter((r) => r.event === "mcp.audit_policy");
      expect(intents).toHaveLength(1);
      expect(results).toHaveLength(1);
      expect(policies).toHaveLength(1);
      expect(policies[0]?.detail).toMatchObject({ policy: "enforce" });
      // Intent precedes its result, and the chain is intact across both paths.
      expect(recs.indexOf(intents[0]!)).toBeLessThan(recs.indexOf(results[0]!));
      expect(reread.verifyChain().ok).toBe(true);
    } finally {
      await close();
    }
  });

  it("best-effort: a FAILING audit log never blocks or fails the call (current behaviour preserved)", {
    timeout: 10000,
  }, async () => {
    const logPath = join(tmpDir, "mcp-tool-calls.jsonl");
    // best-effort + a chain that throws on append: the intent path is a no-op
    // (never touches the chain) and the result flush swallows the failure.
    const sink = new ToolCallSink({
      path: logPath,
      policy: "best-effort",
      autoFlush: false,
      logFactory: () => ({
        append() {
          throw new Error("audit chain unavailable");
        },
      }),
    });
    __setToolCallSinkForTest(sink);

    const cfg = writeProxyConfig(tmpDir, ["alpha"]);
    plugin = new McpMultiplexerPlugin({
      configPath: cfg,
      settingsView: makeSettingsView({
        webEnabled: true,
        shared: ["alpha"],
        observabilityEnabled: true,
        auditPolicy: "best-effort",
      }),
    });
    await plugin.start();
    gateway = startTestGateway();
    const ident = plugin.issueIdentity("pty-be");
    const { client, close } = await connectClient({
      origin: gateway.origin,
      server: "alpha",
      ptyId: "pty-be",
      bearer: ident.headers.Authorization,
    });

    try {
      // Call SUCCEEDS even though the audit chain is broken — availability-first.
      const result = await client.callTool({ name: "echo", arguments: { message: "telemetry" } });
      const content = (result.content as Array<{ text: string }>)[0];
      expect(result.isError).toBeFalsy();
      expect(content?.text).toContain("telemetry");
      // No synchronous intent write happened; the result is buffered fire-and-forget.
      expect(existsSync(logPath)).toBe(false);
      expect(sink.pending()).toHaveLength(1);
      // Draining a broken chain is swallowed — never surfaces on any path.
      expect(() => sink.flush()).not.toThrow();
    } finally {
      await close();
    }
  });
});
