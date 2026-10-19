import type { BusAgentSettings } from "./config.js";
import { effectiveAgentSupervision } from "./bus/agent-resolver.js";
import { defaultSupervisionFor } from "./bus/types.js";

export function logExecutionEngineSummary(
  settings: Parameters<typeof executionEngineSummary>[0],
  logger: Pick<Console, "log">,
): void {
  logger.log(`  ${executionEngineSummary(settings)}`);
}

export interface PtyMcpSharingState {
  ptyEnabled: boolean;
  /** Names in `settings.mcp.shared`. */
  sharedServerCount: number;
  webEnabled: boolean;
  /** `plugin.isActive()` after start; false when never started or left dormant. */
  multiplexerActive: boolean;
}

/**
 * Startup warning for PTY as the default engine while the MCP multiplexer is not
 * running (#550, raised on #62 and #64). Without it every PTY session loads the
 * operator's own MCP servers per process. Returns null when there is nothing to
 * warn about (PTY off, or the multiplexer is serving). Called once at startup.
 */
export function ptyWithoutSharedMcpWarning(state: PtyMcpSharingState): string | null {
  if (!state.ptyEnabled || state.multiplexerActive) return null;
  const why =
    state.sharedServerCount === 0
      ? "mcp.shared is empty"
      : !state.webEnabled
        ? "web.enabled is false"
        : "it started dormant";
  return `[mcp-multiplexer] pty.enabled is true but the multiplexer is not running (${why}): each PTY session spawns its own copy of your MCP servers. To share one set, list the servers in settings.mcp.shared, define them in ~/.config/claudeclaw/mcp-proxy.json and set web.enabled: true (docs/mcp-proxy.md).`;
}

/**
 * Startup snapshot of which engine each path runs on. Declared bus agents show the
 * resolver's effective supervision (`effectiveAgentSupervision`), which does not vary
 * by platform; `bus non-channel default` is the origin fallback for hand-built
 * AgentConfigs, which is `process-stream-json` on win32.
 */
export function executionEngineSummary(
  settings: {
    pty: { enabled: boolean };
    agents: readonly BusAgentSettings[];
  },
  platform: NodeJS.Platform = process.platform,
): string {
  const runner = settings.pty.enabled ? "pty" : "print";
  const busDefault = defaultSupervisionFor("cron", platform);
  const agents =
    settings.agents.map((agent) => `${agent.id}=${effectiveAgentSupervision(agent)}`).join(", ") ||
    "none";
  return `Engines: agent turns=${runner}; cron jobs=${runner}; bus non-channel default=${busDefault}; bus agents=${agents}`;
}
