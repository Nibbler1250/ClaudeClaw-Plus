import { describe, expect, it } from "bun:test";
import {
  executionEngineSummary,
  logExecutionEngineSummary,
  ptyWithoutSharedMcpWarning,
} from "../execution-engines.js";

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

describe("#562 review: PTY default without the MCP multiplexer", () => {
  const base = {
    ptyEnabled: true,
    sharedServerCount: 0,
    webEnabled: false,
    multiplexerActive: false,
  };
  it("warns when PTY is on and mcp.shared is empty, naming the consequence and the fix", () => {
    const warning = ptyWithoutSharedMcpWarning(base);
    expect(warning).toContain("mcp.shared is empty");
    expect(warning).toContain("each PTY session spawns its own copy of your MCP servers");
    expect(warning).toContain("mcp.shared");
    expect(warning).toContain("web.enabled: true");
    expect(warning).toContain("mcp-proxy.json");
  });
  it("names web.enabled false and a dormant start as the reason", () => {
    expect(ptyWithoutSharedMcpWarning({ ...base, sharedServerCount: 2 })).toContain(
      "web.enabled is false",
    );
    expect(
      ptyWithoutSharedMcpWarning({ ...base, sharedServerCount: 2, webEnabled: true }),
    ).toContain("it started dormant");
  });
  it("stays quiet when PTY is off or the multiplexer is serving", () => {
    expect(ptyWithoutSharedMcpWarning({ ...base, ptyEnabled: false })).toBeNull();
    expect(
      ptyWithoutSharedMcpWarning({
        ptyEnabled: true,
        sharedServerCount: 2,
        webEnabled: true,
        multiplexerActive: true,
      }),
    ).toBeNull();
  });
});
