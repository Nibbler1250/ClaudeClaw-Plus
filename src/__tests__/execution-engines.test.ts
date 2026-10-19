import { describe, expect, it } from "bun:test";
import { executionEngineSummary, logExecutionEngineSummary } from "../execution-engines.js";

describe("#550 startup engine summary", () => {
  it("names the runner, cron and bus default engines", () => {
    expect(executionEngineSummary({ pty: { enabled: true }, agents: [] })).toBe(
      "Engines: agent turns=pty; cron jobs=pty; bus non-channel default=pty-stdin; bus agents=none",
    );
  });
  it("shows explicit print overrides independently from the bus default", () => {
    const summary = executionEngineSummary({
      pty: { enabled: false },
      agents: [{ id: "reporter", supervision: "process-stream-json" }, { id: "default" }],
    });
    expect(summary).toContain("agent turns=print; cron jobs=print");
    expect(summary).toContain("bus non-channel default=pty-stdin");
    expect(summary).toContain("reporter=process-stream-json, default=pty-stdin");
  });
  it("startup actually emits the summary", () => {
    const lines: string[] = [];
    logExecutionEngineSummary(
      { pty: { enabled: true }, agents: [] },
      { log: (line) => lines.push(line) },
    );
    expect(lines).toEqual([
      "  Engines: agent turns=pty; cron jobs=pty; bus non-channel default=pty-stdin; bus agents=none",
    ]);
  });
  it("win32: a declared agent without supervision is pty-stdin, as the resolver runs it", () => {
    // resolveBusAgentConfig gives every declared agent `pty-stdin` on every platform; only
    // the origin fallback for hand-built AgentConfigs is process-stream-json on win32.
    const summary = executionEngineSummary(
      { pty: { enabled: false }, agents: [{ id: "default" }, { id: "cli", supervision: "tmux" }] },
      "win32",
    );
    expect(summary).toContain("bus non-channel default=process-stream-json");
    expect(summary).toContain("bus agents=default=pty-stdin, cli=tmux");
  });
});
