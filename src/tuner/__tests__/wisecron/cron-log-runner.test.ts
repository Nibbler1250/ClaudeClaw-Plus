import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCronLogRunner } from "../../wisecron/observation-readers.js";
import { CronSubject } from "../../subjects/cron-subject.js";

const SINCE = new Date("2026-05-20T00:00:00Z");
const JOURNAL_ARGS = [
  "--user",
  "-u",
  "wisecron-*.service",
  "--since",
  SINCE.toISOString(),
  "--output",
  "json",
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cron-log-runner-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a log file and stamp its mtime so the window filter is deterministic. */
function writeLog(name: string, lines: string[], mtime: Date): void {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n"));
  utimesSync(path, mtime, mtime);
}

describe("makeCronLogRunner", () => {
  it("maps success + failure markers to journalctl EXIT_STATUS JSON lines", async () => {
    writeLog(
      "tuner-skills.log",
      [
        "Running cycle since=24h dry=false",
        "Proposed: 0  Auto-applied: 0",
        'error: Module not found "src/skills-tuner/cli/index.ts"',
        "Running cycle since=24h dry=false",
        "Proposed: 2  Auto-applied: 0",
      ],
      new Date("2026-05-21T09:00:00Z"),
    );
    const runner = makeCronLogRunner({ logDir: dir });
    const raw = await runner(JOURNAL_ARGS);
    const entries = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    expect(entries.length).toBe(3); // 2 Proposed + 1 Module-not-found
    const fails = entries.filter((e) => e.EXIT_STATUS === "1");
    const oks = entries.filter((e) => e.EXIT_STATUS === "0");
    expect(fails.length).toBe(1);
    expect(oks.length).toBe(2);
    expect(entries[0]._SYSTEMD_USER_UNIT).toBe("tuner-skills");
    // µsec timestamp from mtime, parseable back by the subject.
    expect(Number(entries[0].__REALTIME_TIMESTAMP)).toBeGreaterThan(0);
  });

  it("excludes tuner self-diagnostic lines (no false-positive failures)", async () => {
    writeLog(
      "wisecron-cron-run.log",
      [
        "[tuner] subject 'mcp_plugin' fitness: active metric='mcp_tool_failure_rate' source=tool_call",
        "[tuner] subject 'cron' health: producer_found=false, match_rate=0.00, reason=\"journalctl runner failed\"",
        "✅ wisecron cron-run: 0 proposal(s) persisted (status=pending)",
      ],
      new Date("2026-05-21T05:10:00Z"),
    );
    const runner = makeCronLogRunner({ logDir: dir });
    const entries = (await runner(JOURNAL_ARGS))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    // Only the ✅ line counts; the two diagnostic lines are filtered out.
    expect(entries.length).toBe(1);
    expect(entries[0].EXIT_STATUS).toBe("0");
  });

  it("skips files whose mtime predates the window", async () => {
    writeLog(
      "tuner-skills.log",
      ['error: Module not found "x"', "Proposed: 0  Auto-applied: 0"],
      new Date("2026-05-01T00:00:00Z"), // before SINCE
    );
    const runner = makeCronLogRunner({ logDir: dir });
    expect(await runner(JOURNAL_ARGS)).toBe("");
  });

  it("ignores files outside the cron-log filter", async () => {
    writeLog(
      "archiviste-rebuild-20260521.log",
      ['error: Module not found "x"'],
      new Date("2026-05-21T02:00:00Z"),
    );
    const runner = makeCronLogRunner({ logDir: dir });
    expect(await runner(JOURNAL_ARGS)).toBe("");
  });

  it("returns '' when the log dir does not exist", async () => {
    const runner = makeCronLogRunner({ logDir: join(dir, "nope") });
    expect(await runner(JOURNAL_ARGS)).toBe("");
  });

  it("feeds CronSubject.collectObservations end-to-end → obs>0 on a failing unit", async () => {
    writeLog(
      "tuner-skills.log",
      [
        "Proposed: 0  Auto-applied: 0",
        'error: Module not found "src/skills-tuner/cli/index.ts"',
        "Proposed: 0  Auto-applied: 0",
      ],
      new Date("2026-05-21T09:00:00Z"),
    );
    const subject = new CronSubject({ journalRunner: makeCronLogRunner({ logDir: dir }) });
    const obs = await subject.collectObservations(SINCE);
    expect(obs.length).toBeGreaterThan(0);
    const meta = obs[0]!.metadata as Record<string, unknown>;
    expect(meta.unit).toBe("tuner-skills");
    expect(meta.error_rate as number).toBeGreaterThan(0);
  });

  it("emits no observation when the unit's runs are all clean and fresh", async () => {
    // mtime = now → not stale (staleness is measured against the wall clock,
    // not `since`), and no failure markers → no observation.
    writeLog(
      "tuner-skills.log",
      ["Proposed: 0  Auto-applied: 0", "Proposed: 1  Auto-applied: 0"],
      new Date(),
    );
    const subject = new CronSubject({ journalRunner: makeCronLogRunner({ logDir: dir }) });
    const obs = await subject.collectObservations(SINCE);
    expect(obs.length).toBe(0);
  });

  it("flags a clean-but-stale unit as an orphan observation", async () => {
    // No failures, but the last run is far older than the 168h stale threshold.
    // mtime = 10 days ago (relative to the wall clock so the assertion is stable).
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3_600_000);
    writeLog("tuner-skills.log", ["Proposed: 0  Auto-applied: 0"], tenDaysAgo);
    const subject = new CronSubject({ journalRunner: makeCronLogRunner({ logDir: dir }) });
    const obs = await subject.collectObservations(SINCE);
    expect(obs.length).toBe(1);
    expect((obs[0]!.metadata as Record<string, unknown>).stale).toBe(true);
  });
});
