import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { executionEngineSummary } from "../execution-engines.js";

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
    const source = readFileSync(new URL("../commands/start.ts", import.meta.url), "utf8");
    expect(source.includes("console.log(`  ${executionEngineSummary(settings)}`)")).toBe(true);
  });
});
