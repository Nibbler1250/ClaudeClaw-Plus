import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../../skills-tuner/core/audit-log.js";

describe("AuditLog — tamper-evident append-only chain", () => {
  it("chains hashes and verifies a clean log", () => {
    const log = new AuditLog();
    log.append({ event: "fitness_active", subject: "cron", metric: "cron_cost" });
    log.append({
      event: "baseline_snapshot",
      subject: "cron",
      metric: "cron_cost",
      proposal_id: "1",
    });
    log.append({
      event: "verdict",
      subject: "cron",
      metric: "cron_cost",
      proposal_id: "1",
      detail: { verdict: "improved" },
    });
    const records = log.all();
    expect(records.length).toBe(3);
    expect(records[0]!.prev_hash).toBe("0".repeat(64));
    expect(records[1]!.prev_hash).toBe(records[0]!.hash);
    expect(records[2]!.prev_hash).toBe(records[1]!.hash);
    expect(log.verifyChain().ok).toBe(true);
  });

  it("defaults actor to system and accepts explicit human attribution", () => {
    const log = new AuditLog();
    const r1 = log.append({ event: "revert", proposal_id: "9" });
    const r2 = log.append({ event: "revert", proposal_id: "9", actor: "human:simon" });
    expect(r1.actor).toBe("system");
    expect(r2.actor).toBe("human:simon");
  });

  it("persists to disk and continues the chain across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    try {
      const path = join(dir, "audit.jsonl");
      const a = new AuditLog(path);
      a.append({ event: "fitness_active", subject: "claude_md", metric: "broken_import_count" });
      const reopened = new AuditLog(path);
      reopened.append({ event: "baseline_snapshot", subject: "claude_md", proposal_id: "2" });
      expect(reopened.all().length).toBe(2);
      expect(reopened.all()[1]!.prev_hash).toBe(reopened.all()[0]!.hash);
      expect(reopened.verifyChain().ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects tampering — editing an earlier record breaks the chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    try {
      const path = join(dir, "audit.jsonl");
      const a = new AuditLog(path);
      a.append({ event: "verdict", proposal_id: "1", detail: { verdict: "regressed" } });
      a.append({ event: "verdict", proposal_id: "2", detail: { verdict: "improved" } });
      // Tamper: rewrite the first line's detail, keep its stored hash.
      const lines = readFileSync(path, "utf8").trim().split("\n");
      const rec0 = JSON.parse(lines[0]!);
      rec0.detail = { verdict: "improved" }; // flip the outcome
      lines[0] = JSON.stringify(rec0);
      writeFileSync(path, `${lines.join("\n")}\n`);
      const check = new AuditLog(path).verifyChain();
      expect(check.ok).toBe(false);
      expect(check.brokenAtSeq).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
