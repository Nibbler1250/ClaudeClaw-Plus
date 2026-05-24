/**
 * Serve the tuner with telemetry flowing THROUGH the MCP bridge.
 *
 * This is the wiring the design mandates: the host produces telemetry and
 * exposes it on the MCP surface (`registerHostTelemetryTools`); the tuner
 * consumes it via an `McpTelemetryProvider` that calls those tools — never
 * reading journalctl/files in-process. The activation gate + every subject's
 * `measureFitness` therefore reach the host only through MCP, and the bridge's
 * invoke-audit plus the OutcomeLoop `telemetry_query` chain together trace each
 * measurement.
 *
 * In-process (`bridgeToolCaller`) the MCP boundary is a function call across the
 * bridge — same auditing, same decoupling. Over a real transport, swap in
 * `mcpClientToolCaller(client)`; the tuner code is identical either way.
 */

import type { Registry } from "../../skills-tuner/core/registry.js";
import type { LLMClient } from "../../skills-tuner/core/llm.js";
import { AuditLog } from "../../skills-tuner/core/audit-log.js";
import type { TelemetryProvider } from "../../skills-tuner/core/telemetry.js";
import { getMcpBridge } from "../../plugins/mcp-bridge.js";
import type { PluginMcpBridge } from "../../plugins/mcp-bridge.js";
import { buildHostTelemetryProvider, type HostTelemetryConfig } from "./host-telemetry-provider.js";
import {
  bridgeToolCaller,
  McpTelemetryProvider,
  registerHostTelemetryTools,
  type TelemetryMcpClient,
} from "./telemetry-mcp.js";
import { registerWisecronSubjects, type WisecronContext } from "./index.js";
import type { WisecronSettings } from "./types.js";

export interface ServeTunerOverMcpOpts {
  /** Host-side producer. Defaults to the reference-host composite. */
  hostProvider?: TelemetryProvider;
  /** Config forwarded to the default reference-host producer. */
  hostConfig?: HostTelemetryConfig;
  /** Bridge to host the telemetry tools on. Defaults to the process singleton. */
  bridge?: PluginMcpBridge;
  /**
   * Consumer transport to the telemetry tools. Defaults to an in-process
   * caller over the same bridge. Pass `mcpClientToolCaller(client)` to consume
   * over a real MCP transport.
   */
  client?: TelemetryMcpClient;
  /** Shared OutcomeLoop audit chain (host query records + activation gate). */
  audit?: AuditLog;
  llm?: LLMClient;
  runHealthChecks?: boolean;
}

export interface ServedTuner extends WisecronContext {
  /** The host-side producer registered on the bridge. */
  hostProvider: TelemetryProvider;
  /** The MCP-backed provider the subjects consume. */
  mcpProvider: McpTelemetryProvider;
  /** The audit chain telemetry queries + activations are written to. */
  audit: AuditLog;
}

/**
 * Register the host telemetry surface on the bridge, connect an
 * `McpTelemetryProvider` to it, and register the wisecron subjects consuming
 * that provider. Returns the orchestration handles plus the wired providers.
 */
export async function serveTunerOverMcp(
  registry: Registry,
  settings: WisecronSettings,
  opts: ServeTunerOverMcpOpts = {},
): Promise<ServedTuner> {
  const bridge = opts.bridge ?? getMcpBridge();
  const audit = opts.audit ?? new AuditLog();
  const hostProvider = opts.hostProvider ?? buildHostTelemetryProvider(opts.hostConfig ?? {});

  // HOST: expose telemetry on the MCP surface, recording served queries.
  registerHostTelemetryTools(bridge, { provider: hostProvider, audit });

  // TUNER: consume telemetry only through MCP.
  const client = opts.client ?? bridgeToolCaller(bridge);
  const mcpProvider = new McpTelemetryProvider(client);
  await mcpProvider.connect();

  const ctx = registerWisecronSubjects(registry, settings, {
    llm: opts.llm,
    runHealthChecks: opts.runHealthChecks,
    telemetry: mcpProvider,
    audit,
  });

  return { ...ctx, hostProvider, mcpProvider, audit };
}
