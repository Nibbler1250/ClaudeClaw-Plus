// Isolated subprocess fixture: every runner file lives under the caller's
// temporary cwd and every Claude execution is intercepted before spawning.
import { spyOn } from "bun:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { PtyTurnTimeoutError } from "../../runner/pty-process.js";

const config = await import("../../config.js");
const runner = await import("../../runner.js");
const supervisor = await import("../../runner/pty-supervisor.js");
const sessions = await import("../../sessionManager.js");
const globalSessions = await import("../../sessions.js");
const { createJobLoop } = await import("../../job-loop.js");
const rawScenario = process.argv[2] ?? "cron";
const scenario = rawScenario.replace(/^legacy-/, "");
await config.initConfig();
const settingsPath = join(process.cwd(), ".claude/claudeclaw/settings.json");
if (scenario === "compact" && !rawScenario.startsWith("legacy-")) {
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  settings.pty.maxRetries = 0;
  await writeFile(settingsPath, JSON.stringify(settings));
}
if (scenario.startsWith("fallback-")) {
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  settings.fallback = { model: "", api: "test-routing-only" };
  await writeFile(settingsPath, JSON.stringify(settings));
}
if (scenario === "legacy" || rawScenario.startsWith("legacy-")) {
  await writeFile(
    join(process.cwd(), ".claude/claudeclaw/settings.json"),
    JSON.stringify({ pty: { enabled: false } }),
  );
}
await config.loadSettings();
await writeFile(join(process.cwd(), "CLAUDE.md"), "Test fixture\n");
const ptyCalls: string[] = [];
const retired: string[] = [];
const events: string[] = [];
const modelOverrides: Array<string | undefined> = [];
const chunks: string[] = [];
const tools: string[] = [];
const realRunOnPty = supervisor.runOnPty;
const realRetire = supervisor.retirePtySession;
let bootstrapTimeoutMs = 0;
let bootstrapError = "";
supervisor.injectSleep(async () => {});
supervisor.injectIsSessionResumable(async () => true);
supervisor.injectSpawnPty(async (opts) => ({
  label: "fixture",
  pid: 550,
  sessionId: opts.sessionId || "fixture",
  cwd: opts.cwd,
  isAlive: () => true,
  lastTurnEndedAt: () => 0,
  exitInfo: () => null,
  runTurn: async () => {
    events.push("timeout");
    throw new PtyTurnTimeoutError("fixture", 10);
  },
  dispose: async () => {
    events.push("disposed");
  },
}));
let primaryRoute = "";
let agentPrintCalls = 0;
let utilityPrintCalls = 0;
spyOn(supervisor, "runOnPty").mockImplementation(async (key, _prompt, opts) => {
  ptyCalls.push(key);
  if (scenario === "bootstrap-attempt" && ptyCalls.length === 1) {
    bootstrapTimeoutMs = opts.timeoutMs;
    return realRunOnPty(key, _prompt, opts);
  }
  modelOverrides.push(opts.modelOverride);
  opts.onChunk?.("fallback-chunk");
  opts.onToolEvent?.("fallback-tool");
  if (scenario === "fallback-rendered" && ptyCalls.length === 1)
    return {
      rawStdout: 'API Error: 400 {"error":{"message":"Invalid `signature` in `thinking` block"}}',
      stderr: "",
      exitCode: 0,
    };
  if (scenario === "fallback-model" && ptyCalls.length === 1)
    return {
      rawStdout: "",
      stderr: "No conversation found with session ID: fallback-old",
      exitCode: 1,
    };
  return { rawStdout: "pty-ok", stderr: "", exitCode: 0, sessionId: "fresh-pty" };
});
spyOn(supervisor, "retirePtySession").mockImplementation(async (key) => {
  events.push("retire");
  retired.push(key);
  if (scenario === "compact" || scenario === "bootstrap-attempt") await realRetire(key);
});
runner._setClaudeSpawnForTests((args) => {
  const prompt = args[args.indexOf("-p") + 1] ?? "";
  if (prompt === "/compact" || prompt.startsWith("Session is about to compact.")) {
    utilityPrintCalls++;
    events.push(prompt === "/compact" ? "utility-compact" : "utility-memory");
  } else agentPrintCalls++;
  return Bun.spawn(
    [
      "printf",
      "%s\n",
      JSON.stringify({ type: "result", result: "legacy-ok", session_id: "legacy-sid" }),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
});
let primary = true;
if (
  [
    "bootstrap",
    "corrupt",
    "stale",
    "compact",
    "rendered-corrupt",
    "fallback-model",
    "fallback-stream",
    "fallback-rendered",
  ].includes(scenario)
) {
  if (scenario !== "bootstrap") await sessions.createThreadSession("fixture-thread", "old-sid");
  if (scenario === "fallback-rendered")
    await globalSessions.createFallbackSession("fallback-old", undefined, "fixture-thread");
  runner._setPrimaryExecForTests(async (input) => {
    primaryRoute = input.route;
    if (!primary) throw new Error("unexpected repeat primary call");
    primary = false;
    if (scenario.startsWith("fallback-"))
      return { rawStdout: "You've hit your limit · resets 5pm (UTC)", stderr: "", exitCode: 1 };
    if (scenario === "rendered-corrupt")
      return {
        rawStdout: 'API Error: 400 {"error":{"message":"Invalid `signature` in `thinking` block"}}',
        stderr: "",
        exitCode: 0,
      };
    if (scenario === "corrupt")
      return { rawStdout: "", stderr: "Invalid signature in thinking block", exitCode: 1 };
    if (scenario === "stale")
      return {
        rawStdout: "",
        stderr: "No conversation found with session ID: old-sid",
        exitCode: 1,
      };
    if (scenario === "compact") {
      if (input.route === "pty")
        return realRunOnPty("thread:fixture-thread", "test prompt", {
          timeoutMs: 1000,
          threadId: "fixture-thread",
        });
      return { rawStdout: "", stderr: "timeout", exitCode: 124 };
    }
    return { rawStdout: "boot-ok", stderr: "", exitCode: 0, sessionId: "bootstrap-sid" };
  });
}
let exitCode: number;
if (scenario === "bootstrap-attempt") {
  const boot = runner.bootstrap().catch((error) => {
    bootstrapError = error.message;
  });
  const next = runner.run("chat", "after bootstrap");
  await boot;
  exitCode = (await next).exitCode;
} else if (scenario === "cron" || scenario === "legacy") {
  const loop = createJobLoop({
    run: runner.run,
    resolvePrompt: async (text) => text,
    resolveJobModel: async () => undefined,
    snapshotJobFrontmatter: async () => async () => false,
    clearJobSchedule: async () => {},
    forward: () => {},
    busAgentIds: () => [],
    hasLegacyPersona: async () => false,
    isRateLimited: () => false,
    timezoneOffsetMinutes: () => 0,
  });
  loop.tick(
    [
      {
        name: "due",
        schedule: "* * * * *",
        prompt: "run scheduled work",
        recurring: true,
        notify: false,
      },
    ],
    new Date(),
  );
  const deadline = Date.now() + 3000;
  while (!loop.lastResult.has("due") && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  exitCode = loop.lastResult.get("due")?.result === "ok" ? 0 : 1;
} else {
  exitCode = (
    await runner.run(
      scenario === "bootstrap" ? "bootstrap" : "chat",
      "test prompt",
      scenario === "bootstrap" ? undefined : "fixture-thread",
      scenario.startsWith("fallback-") ? "override-model" : undefined,
      undefined,
      undefined,
      undefined,
      (chunk) => chunks.push(chunk),
      (tool) => tools.push(tool),
    )
  ).exitCode;
}
console.log(
  `FIXTURE_RESULT ${JSON.stringify({ enabled: config.getSettings().pty.enabled, exitCode, primaryRoute, ptyCalls, retired, agentPrintCalls, utilityPrintCalls, events, modelOverrides, chunks, tools, bootstrapTimeoutMs, bootstrapError })}`,
);
