// Isolated subprocess fixture: every runner file lives under the caller's
// temporary cwd and every Claude execution is intercepted before spawning.
import { spyOn } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

const config = await import("../../config.js");
const runner = await import("../../runner.js");
const supervisor = await import("../../runner/pty-supervisor.js");
const sessions = await import("../../sessionManager.js");
const { createJobLoop } = await import("../../job-loop.js");
const rawScenario = process.argv[2] ?? "cron";
const scenario = rawScenario.replace(/^legacy-/, "");
await config.initConfig();
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
let primaryRoute = "";
let agentPrintCalls = 0;
let utilityPrintCalls = 0;
spyOn(supervisor, "runOnPty").mockImplementation(async (key, _prompt) => {
  ptyCalls.push(key);
  return { rawStdout: "pty-ok", stderr: "", exitCode: 0, sessionId: "fresh-pty" };
});
spyOn(supervisor, "retirePtySession").mockImplementation(async (key) => {
  retired.push(key);
});
runner._setClaudeSpawnForTests((args) => {
  const prompt = args[args.indexOf("-p") + 1] ?? "";
  if (prompt === "/compact" || prompt.startsWith("Session is about to compact."))
    utilityPrintCalls++;
  else agentPrintCalls++;
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
if (["bootstrap", "corrupt", "stale", "compact"].includes(scenario)) {
  if (scenario !== "bootstrap") await sessions.createThreadSession("fixture-thread", "old-sid");
  runner._setPrimaryExecForTests(async (input) => {
    primaryRoute = input.route;
    if (!primary) throw new Error("unexpected repeat primary call");
    primary = false;
    if (scenario === "corrupt")
      return { rawStdout: "", stderr: "Invalid signature in thinking block", exitCode: 1 };
    if (scenario === "stale")
      return {
        rawStdout: "",
        stderr: "No conversation found with session ID: old-sid",
        exitCode: 1,
      };
    if (scenario === "compact") return { rawStdout: "", stderr: "timeout", exitCode: 124 };
    return { rawStdout: "boot-ok", stderr: "", exitCode: 0, sessionId: "bootstrap-sid" };
  });
}
let exitCode: number;
if (scenario === "cron" || scenario === "legacy") {
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
    )
  ).exitCode;
}
console.log(
  `FIXTURE_RESULT ${JSON.stringify({ enabled: config.getSettings().pty.enabled, exitCode, primaryRoute, ptyCalls, retired, agentPrintCalls, utilityPrintCalls })}`,
);
