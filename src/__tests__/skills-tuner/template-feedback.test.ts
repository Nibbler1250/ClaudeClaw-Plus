import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTemplateFeedback,
  isTemplateVerdict,
  VERDICT_RATING,
  type TemplateFeedbackEntry,
} from "../../skills-tuner/core/template-feedback";

describe("template-feedback", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tmpl-feedback-"));
    path = join(dir, "nested", "template_feedback.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("maps verdicts onto the 1..5 scale the subject buckets on", () => {
    expect(VERDICT_RATING.yes).toBe(5); // >= 4 positive
    expect(VERDICT_RATING["yes-but"]).toBe(3); // neutral
    expect(VERDICT_RATING.no).toBe(1); // <= 2 correction
  });

  it("validates verdicts", () => {
    expect(isTemplateVerdict("yes")).toBe(true);
    expect(isTemplateVerdict("yes-but")).toBe(true);
    expect(isTemplateVerdict("no")).toBe(true);
    expect(isTemplateVerdict("maybe")).toBe(false);
  });

  it("appends a well-formed line (creating the parent dir) matching the subject reader shape", () => {
    const entry = appendTemplateFeedback(
      { templateId: "daily-brief", verdict: "yes", comment: "nailed it", ts: "2026-05-20T00:00:00.000Z" },
      path,
    );
    expect(existsSync(path)).toBe(true);
    expect(entry.rating).toBe(5);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as TemplateFeedbackEntry;
    expect(parsed).toEqual({
      ts: "2026-05-20T00:00:00.000Z",
      template_id: "daily-brief",
      rating: 5,
      verdict: "yes",
      comment: "nailed it",
    });
  });

  it("omits comment when not provided", () => {
    appendTemplateFeedback({ templateId: "t1", verdict: "no", ts: "2026-05-20T00:00:00.000Z" }, path);
    const parsed = JSON.parse(readFileSync(path, "utf8").trim());
    expect(parsed.comment).toBeUndefined();
    expect(parsed.rating).toBe(1);
  });

  it("throws on an invalid verdict", () => {
    // @ts-expect-error testing runtime guard with a bad value
    expect(() => appendTemplateFeedback({ templateId: "t1", verdict: "bad" }, path)).toThrow(
      /invalid verdict/,
    );
  });
});
