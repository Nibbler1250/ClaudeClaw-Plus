import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getMcpBridge } from "../plugins/mcp-bridge.js";
import { startMcpServer } from "../plugins/mcp-server.js";
import type { PluginApi } from "../plugins.js";

export async function mcpServe(): Promise<void> {
  // Redirect all console output to log file.
  // stdout is reserved for MCP JSON-RPC protocol — anything written there corrupts the framing.
  const logDir = join(homedir(), ".cache", "claudeclaw");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "mcp-serve.log");
  const logStream = createWriteStream(logPath, { flags: "a" });

  const ts = () => new Date().toISOString();
  const log = (...args: unknown[]) =>
    logStream.write(`[${ts()}] ` + args.map(String).join(" ") + "\n");

  console.log = log;
  console.info = log;
  console.warn = (...args: unknown[]) =>
    logStream.write(`[${ts()}] [WARN] ` + args.map(String).join(" ") + "\n");
  console.error = (...args: unknown[]) =>
    logStream.write(`[${ts()}] [ERROR] ` + args.map(String).join(" ") + "\n");

  log("[mcp-serve] starting");

  // Load built-in skills-tuner plugin directly.
  // Using built-in registration rather than PluginManager.loadAll() because the
  // PluginManager path resolver looks for .js files only, while this codebase's
  // TypeScript sources run directly under Bun. Future npm-distributed plugins
  // can use the standard loadAll() path.
  try {
    const { default: skillsTunerPlugin } = await import("../plugins/skills-tuner/index.js");
    const bridge = getMcpBridge();
    const api: PluginApi = {
      on: () => {},
      registerService: () => {},
      registerCommand: () => {},
      registerTool: (tool) => bridge.registerPluginTool("skills-tuner", tool),
      runtime: { channel: {} },
      logger: {
        info: (...args: unknown[]) => log("[skills-tuner]", ...args),
        warn: (...args: unknown[]) => log("[WARN] [skills-tuner]", ...args),
        error: (...args: unknown[]) => log("[ERROR] [skills-tuner]", ...args),
        debug: () => {},
      },
      pluginConfig: {},
    };
    await skillsTunerPlugin(api);
    log("[mcp-serve] built-in skills-tuner plugin loaded (9 tools registered)");
  } catch (err) {
    process.stderr.write(`[mcp-serve] Fatal: skills-tuner plugin failed to load: ${err}\n`);
    process.exit(1);
  }

  log("[mcp-serve] starting MCP server on stdio");
  await startMcpServer();
}
