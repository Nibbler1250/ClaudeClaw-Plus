/**
 * ClaudeClaw-Plus MCP stdio server
 *
 * Exposes all plugin-registered tools via the Model Context Protocol.
 * Run standalone: bun run src/plugins/mcp-server.ts
 *
 * Or configure in claude_desktop_config.json:
 *   { "mcpServers": { "claudeclaw-plus": { "command": "bun", "args": ["run", "/path/to/mcp-server.ts"] } } }
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AuditLog } from "../skills-tuner/core/audit-log.js";
import type { TelemetryProvider } from "../skills-tuner/core/telemetry.js";
import { registerHostTelemetryTools } from "../tuner/wisecron/telemetry-mcp.js";
import { getMcpBridge } from "./mcp-bridge.js";

export interface StartMcpServerOpts {
  /**
   * Host telemetry surface to serve over the bridge as `telemetry__capabilities`
   * + `telemetry__query`. When supplied, a consuming tuner reads fitness through
   * MCP instead of in-process. Omit to serve plugin tools only.
   */
  telemetry?: TelemetryProvider;
  /** Tamper-evident chain that records each served telemetry query. */
  audit?: AuditLog;
  /** Transport override (tests inject an in-memory pair). Defaults to stdio. */
  transport?: Transport;
}

export async function startMcpServer(opts: StartMcpServerOpts = {}): Promise<void> {
  const bridge = getMcpBridge();

  if (opts.telemetry) {
    registerHostTelemetryTools(bridge, { provider: opts.telemetry, audit: opts.audit });
  }

  const server = new Server(
    { name: "claudeclaw-plus", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // List all registered plugin tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = bridge.listTools();
    return {
      tools: tools.map((t) => ({
        name: t.fqn,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  // Invoke a tool by FQN
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await bridge.invokeTool(name, args ?? {});
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = opts.transport ?? new StdioServerTransport();
  await server.connect(transport);
}

// Run standalone when executed directly: serve plugin tools + the reference-host
// telemetry surface, with served queries recorded to the OutcomeLoop audit chain.
if (import.meta.main) {
  (async () => {
    const { buildHostTelemetryProvider } = await import(
      "../tuner/wisecron/host-telemetry-provider.js"
    );
    const { AuditLog } = await import("../skills-tuner/core/audit-log.js");
    await startMcpServer({
      telemetry: buildHostTelemetryProvider(),
      audit: new AuditLog("~/.config/tuner/outcome-audit.jsonl"),
    });
  })().catch((err) => {
    console.error("[mcp-server] Fatal:", err);
    process.exit(1);
  });
}
