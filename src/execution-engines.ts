import type { BusAgentSettings } from "./config.js";
import { effectiveAgentSupervision } from "./bus/agent-resolver.js";
import { defaultSupervisionFor } from "./bus/types.js";

export function logExecutionEngineSummary(
  settings: Parameters<typeof executionEngineSummary>[0],
  logger: Pick<Console, "log">,
): void {
  logger.log(`  ${executionEngineSummary(settings)}`);
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
