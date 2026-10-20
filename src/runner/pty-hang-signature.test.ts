import { describe, expect, it } from "bun:test";
import { type HangObservation, isHangSignature, rowRetryLine } from "./pty-hang-signature.js";

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
