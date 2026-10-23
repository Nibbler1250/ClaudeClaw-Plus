/**
 * #562 review: the bootstrap timeout per route, and the rendered signature-error scan.
 */
import { describe, expect, it } from "bun:test";
import {
  BOOTSTRAP_PTY_MAX_MS,
  endsInRenderedSignatureError,
  resolveBootstrapTimeoutMs,
} from "../runner";

const FIVE_MINUTES = 5 * 60_000;
const ERROR_LINE =
  'API Error: 400 {"type":"error","error":{"message":"messages.1.content.0: Invalid `signature` in `thinking` block"}}';

describe("resolveBootstrapTimeoutMs", () => {
  it("PTY: a measured 38.7 s cold start (#369) fits; the cap is 120 s under the 5 min default", () => {
    expect(BOOTSTRAP_PTY_MAX_MS).toBeGreaterThan(38_700);
    expect(resolveBootstrapTimeoutMs("pty", FIVE_MINUTES)).toBe(120_000);
  });

  it("PTY: a smaller configured timeouts.default still wins", () => {
    expect(resolveBootstrapTimeoutMs("pty", 60_000)).toBe(60_000);
  });

  it("the explicit print opt-out keeps timeouts.default, uncapped", () => {
    expect(resolveBootstrapTimeoutMs("legacy", FIVE_MINUTES)).toBe(FIVE_MINUTES);
  });
});

describe("endsInRenderedSignatureError", () => {
  it("matches the REPL's rendered error as the last line", () => {
    expect(endsInRenderedSignatureError(ERROR_LINE)).toBe(true);
    expect(endsInRenderedSignatureError(`partial reply\n${ERROR_LINE}\n`)).toBe(true);
  });

  it("matches it when one trailing line follows (a footer / status line)", () => {
    expect(endsInRenderedSignatureError(`${ERROR_LINE}\n\n  ? for shortcuts\n`)).toBe(true);
  });

  it("does NOT match the phrase mid-output followed by normal reply text (a quoted log)", () => {
    const reply = [
      "Here is the failing log from the test run:",
      ERROR_LINE,
      "That error means the stored thinking block no longer matches its signature.",
      "To recover, drop --resume and start a fresh session.",
      "I have not changed anything yet.",
    ].join("\n");
    expect(endsInRenderedSignatureError(reply)).toBe(false);
  });

  it("does NOT match prose that merely mentions the words", () => {
    expect(
      endsInRenderedSignatureError(
        "The API Error: Invalid signature in a thinking block is known.",
      ),
    ).toBe(false);
    expect(endsInRenderedSignatureError("")).toBe(false);
  });
});
