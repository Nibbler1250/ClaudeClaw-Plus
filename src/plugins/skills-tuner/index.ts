/**
 * skills-tuner built-in plugin for ClaudeClaw-Plus MCP bridge.
 *
 * Registers 9 MCP tools wrapping the skills-tuner engine in-process.
 * Loaded as a built-in by `claudeclaw mcp-serve` — no shell-outs.
 *
 * Architecture note: treated as a built-in reference plugin rather than a
 * user-configured plugin entry because the PluginManager path resolver only
 * resolves .js files and the skills-tuner TypeScript sources run directly
 * under Bun in this codebase. Future plugins distributed as npm packages
 * would use the standard PluginManager path resolution.
 */

import type { PluginApi } from "../../plugins.js";
import { loadConfig } from "../../skills-tuner/core/config.js";
import { bootstrapEngine } from "../../skills-tuner/cli/bootstrap.js";
import { makePendingTool } from "./tools/pending.js";
import { makeCronRunTool } from "./tools/cron-run.js";
import { makeApplyTool } from "./tools/apply.js";
import { makeSkipTool } from "./tools/skip.js";
import { makeRevertTool } from "./tools/revert.js";
import { makeFeedbackTool } from "./tools/feedback.js";
import { makeStatsTool } from "./tools/stats.js";
import { makeDoctorTool } from "./tools/doctor.js";
import { makeSetupTool } from "./tools/setup.js";

export default async function skillsTunerPlugin(api: PluginApi): Promise<void> {
  const config = loadConfig();
  const bundle = bootstrapEngine(config);

  api.registerTool(makePendingTool(bundle));
  api.registerTool(makeCronRunTool(bundle));
  api.registerTool(makeApplyTool(bundle));
  api.registerTool(makeSkipTool(bundle));
  api.registerTool(makeRevertTool(bundle));
  api.registerTool(makeFeedbackTool(bundle));
  api.registerTool(makeStatsTool(bundle));
  api.registerTool(makeDoctorTool());
  api.registerTool(makeSetupTool());
}
