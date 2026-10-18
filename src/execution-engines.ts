import type { BusAgentSettings } from "./config.js";
import { defaultSupervisionFor } from "./bus/types.js";

/** Startup snapshot; per-agent overrides remain independent of runner mode. */
export function executionEngineSummary(settings: {
  pty: { enabled: boolean };
  agents: readonly BusAgentSettings[];
}): string {
  const runner = settings.pty.enabled ? "pty" : "print";
  const busDefault = defaultSupervisionFor("cron");
  const agents =
    settings.agents.map((agent) => `${agent.id}=${agent.supervision ?? busDefault}`).join(", ") ||
    "none";
  return `Engines: agent turns=${runner}; cron jobs=${runner}; bus non-channel default=${busDefault}; bus agents=${agents}`;
}
