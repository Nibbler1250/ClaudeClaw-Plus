import { describe, expect, it } from "bun:test";
import {
  ATTEMPT_OVERHEAD_MS,
  type HangObservation,
  isHangSignature,
  RETRY_MARGIN_MS,
  retryRowTimeoutMs,
  rowRetryLine,
  rowRetryResultLine,
} from "./pty-hang-signature.js";

const hung: HangObservation = {
  exitCode: 124,
  reason: "timeout",
  promptSeen: true,
  assistantEntries: 0,
  apiErrors: 0,
};

describe("isHangSignature (#570 r15b)", () => {
  it("the known no-reply hang is the signature", () => {
    expect(isHangSignature(hung)).toBe(true);
  });

  // Each twin changes one field of the signature; any one of them is a result to report, not a hang.
  it.each<[string, Partial<HangObservation>]>([
    ["a clean exit", { exitCode: 0 }],
    ["the fail-closed exit 1", { exitCode: 1 }],
    ["another reason", { reason: "api-error" }],
    ["no reason", { reason: undefined }],
    ["a prompt that never reached the transcript", { promptSeen: false }],
    ["a reply that did arrive", { assistantEntries: 1 }],
    ["an API error record", { apiErrors: 1 }],
  ])("is not the signature: %s", (_name, over) => {
    expect(isHangSignature({ ...hung, ...over })).toBe(false);
  });
});

describe("rowRetryLine", () => {
  it("is the fixed line with only the row label in it", () => {
    expect(rowRetryLine("B3 PTY CONTROL PRESENT")).toBe(
      "[isolation-spike] row-retry B3 PTY CONTROL PRESENT: reason=hang-signature",
    );
  });
});

describe("rowRetryResultLine", () => {
  it("names the second attempt's exit, reason and time", () => {
    expect(rowRetryResultLine("C @ look-alikes CONTROL PRESENT", 0, undefined, 7100)).toBe(
      "[isolation-spike] row-retry C @ look-alikes CONTROL PRESENT: attempt=2 exit=0 reason=none elapsedMs=7100",
    );
    expect(rowRetryResultLine("B3 PTY CONTROL PRESENT", 124, "timeout", 75247)).toBe(
      "[isolation-spike] row-retry B3 PTY CONTROL PRESENT: attempt=2 exit=124 reason=timeout elapsedMs=75247",
    );
  });
});

describe("retryRowTimeoutMs", () => {
  it("is two full attempts plus the margin", () => {
    // Row C: a 60 s call ends at about 75 s, so two attempts and 30 s is 180 s (it had 140 s).
    expect(retryRowTimeoutMs(60_000)).toBe(180_000);
    expect(retryRowTimeoutMs(120_000)).toBe(300_000);
  });

  // The brief's floor, 2 x the per-attempt budget + 30 s, whatever the budget.
  it.each([1_000, 30_000, 60_000, 120_000])("is at least 2 x %d ms + 30 s", (budget) => {
    expect(retryRowTimeoutMs(budget)).toBeGreaterThanOrEqual(2 * budget + 30_000);
  });

  it("covers a hung first attempt and a full second one, as the run that was cut off had them", () => {
    const hungFirst = 60_000 + ATTEMPT_OVERHEAD_MS; // 75 s
    expect(retryRowTimeoutMs(60_000)).toBeGreaterThanOrEqual(2 * hungFirst + RETRY_MARGIN_MS);
    expect(retryRowTimeoutMs(60_000)).toBeGreaterThan(140_000);
  });
});
