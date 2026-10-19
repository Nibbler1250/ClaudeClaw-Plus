import { afterEach, describe, expect, it } from "bun:test";
import {
  confirmRenderedSignatureError,
  endsInRenderedSignatureError,
  hasSignatureError,
  injectSignatureConfirmForTests,
  transcriptEndsInSignatureApiError,
} from "../runner/signature-error";

const ERROR_LINE =
  'API Error: 400 {"type":"error","error":{"message":"messages.1.content.0: Invalid `signature` in `thinking` block"}}';

function elapsedMs(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("hasSignatureError", () => {
  it("matches every real error string", () => {
    expect(hasSignatureError("Invalid `signature` in `thinking` block")).toBe(true);
    expect(hasSignatureError("Invalid signature in thinking block")).toBe(true);
    expect(hasSignatureError("API Error: Invalid signature in a thinking block")).toBe(true);
    expect(hasSignatureError(ERROR_LINE)).toBe(true);
    expect(hasSignatureError("INVALID SIGNATURE IN THINKING BLOCK")).toBe(true);
    expect(hasSignatureError("stderr: Invalid signature in thinking block\nexit 1")).toBe(true);
  });

  it("does not match when a word is missing, out of order, or on another line", () => {
    expect(hasSignatureError("")).toBe(false);
    expect(hasSignatureError("Invalid signature in thinking")).toBe(false);
    expect(hasSignatureError("block thinking signature Invalid")).toBe(false);
    expect(hasSignatureError("Invalid signature\nin thinking block")).toBe(false);
    expect(hasSignatureError("Invalid\nsignature thinking block")).toBe(false);
  });

  it("does not match when the words are spread over more than 600 characters", () => {
    expect(hasSignatureError(`Invalid signature ${"x".repeat(700)} thinking block`)).toBe(false);
    expect(hasSignatureError(`Invalid signature ${"x".repeat(300)} thinking block`)).toBe(true);
  });

  it("finds a later occurrence after an earlier one failed", () => {
    expect(hasSignatureError("Invalid thing\nInvalid signature in thinking block")).toBe(true);
    const farFirst = `Invalid signature ${"x".repeat(700)} thinking block\nInvalid signature thinking block`;
    expect(hasSignatureError(farFirst)).toBe(true);
    expect(hasSignatureError(`Invalid ${"signature ".repeat(5)}thinking block`)).toBe(true);
  });

  // The unbounded pattern took 674 ms on 4 KB and 11 s on 8 KB of this input (about 16x per
  // doubling), on the single JS thread that also runs the pollers and PTY timers. The 3 KB case
  // finishes on the old pattern (a few hundred ms), so a regression shows as a failed assertion
  // rather than a hung suite; the larger cases would not finish on it at all.
  const UNITS: Array<[string, string]> = [
    ["spaced", "Invalid signature thinking "],
    ["dense", "Invalidsignaturethinking"],
  ];
  for (const [name, unit] of UNITS) {
    for (const size of [3_000, 20_000, 200_000]) {
      it(`${name} adversarial single line of ${size} chars is checked in under 50 ms`, () => {
        const text = `${unit.repeat(Math.ceil(size / unit.length)).slice(0, size)}\n`;
        let result = true;
        const ms = elapsedMs(() => {
          result = hasSignatureError(text);
        });
        expect(result).toBe(false);
        expect(ms).toBeLessThan(50);
      });
    }
  }

  it("every candidate fails the 600-character span (a distant block) in linear time", () => {
    for (const size of [20_000, 200_000]) {
      const text = `${"Invalid signature thinking ".repeat(Math.ceil(size / 27))}${"x".repeat(700)} block`;
      let result = true;
      const ms = elapsedMs(() => {
        result = hasSignatureError(text);
      });
      // The last repeat is more than 600 characters from "block", but the one before it is too.
      expect(result).toBe(false);
      expect(ms).toBeLessThan(50);
    }
  });

  it("a 200 KB line with the error at the very end is still found quickly", () => {
    const text = `${"Invalid signature thinking ".repeat(7_500)}\nInvalid signature in thinking block`;
    let result = false;
    const ms = elapsedMs(() => {
      result = hasSignatureError(text);
    });
    expect(result).toBe(true);
    expect(ms).toBeLessThan(50);
  });
});

describe("endsInRenderedSignatureError", () => {
  it("matches the REPL's rendered error as the last line, or with one footer line after it", () => {
    expect(endsInRenderedSignatureError(ERROR_LINE)).toBe(true);
    expect(endsInRenderedSignatureError(`partial reply\n${ERROR_LINE}\n`)).toBe(true);
    expect(endsInRenderedSignatureError(`${ERROR_LINE}\n\n  ? for shortcuts\n`)).toBe(true);
  });

  it("does not match the phrase mid-output followed by reply text, or prose that mentions it", () => {
    const reply = [ERROR_LINE, "That means the stored block is stale.", "I changed nothing."];
    expect(endsInRenderedSignatureError(reply.join("\n"))).toBe(false);
    expect(
      endsInRenderedSignatureError(
        "The API Error: Invalid signature in a thinking block is known.",
      ),
    ).toBe(false);
    expect(endsInRenderedSignatureError("")).toBe(false);
  });

  it("an adversarial 200 KB tail line is rejected quickly", () => {
    const text = `API Error: ${"Invalid signature thinking ".repeat(7_500)}`;
    let result = true;
    const ms = elapsedMs(() => {
      result = endsInRenderedSignatureError(text);
    });
    expect(result).toBe(false);
    expect(ms).toBeLessThan(50);
  });
});

describe("transcriptEndsInSignatureApiError", () => {
  const apiError = {
    type: "assistant",
    isApiErrorMessage: true,
    message: { role: "assistant", content: [{ type: "text", text: ERROR_LINE }] },
  };
  const modelText = {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: ERROR_LINE }] },
  };
  const lines = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n");

  it("is true when the last message entry is the CLI's flagged API-error entry", () => {
    expect(transcriptEndsInSignatureApiError(lines(apiError))).toBe(true);
    expect(transcriptEndsInSignatureApiError(`${lines(apiError)}\n`)).toBe(true);
  });

  it("skips bookkeeping entries after the error, such as last-prompt", () => {
    expect(
      transcriptEndsInSignatureApiError(lines(apiError, { type: "last-prompt", lastPrompt: "x" })),
    ).toBe(true);
  });

  it("is false when the model's own text quotes the error (no isApiErrorMessage flag)", () => {
    expect(transcriptEndsInSignatureApiError(lines(modelText))).toBe(false);
    expect(transcriptEndsInSignatureApiError(lines(apiError, modelText))).toBe(false);
  });

  it("is false when a later message follows the error, or the error is another one", () => {
    const userAfter = { type: "user", message: { role: "user", content: "next" } };
    expect(transcriptEndsInSignatureApiError(lines(apiError, userAfter))).toBe(false);
    const other = {
      ...apiError,
      message: { role: "assistant", content: [{ type: "text", text: "Prompt is too long" }] },
    };
    expect(transcriptEndsInSignatureApiError(lines(other))).toBe(false);
  });

  it("tolerates a first line cut mid-entry and garbage lines", () => {
    expect(transcriptEndsInSignatureApiError(`ssage":"cut"}\n${lines(apiError)}`)).toBe(true);
    expect(transcriptEndsInSignatureApiError("not json\n")).toBe(false);
    expect(transcriptEndsInSignatureApiError("")).toBe(false);
  });
});

describe("confirmRenderedSignatureError", () => {
  afterEach(() => injectSignatureConfirmForTests(null));
  const apiErrorTail = JSON.stringify({
    type: "assistant",
    isApiErrorMessage: true,
    message: { content: [{ type: "text", text: ERROR_LINE }] },
  });
  const modelTextTail = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: ERROR_LINE }] },
  });
  function inject(tail: string | null) {
    const reads: string[] = [];
    let sleeps = 0;
    injectSignatureConfirmForTests({
      readTail: async (cwd, id) => {
        reads.push(`${cwd}:${id}`);
        return tail;
      },
      sleep: async () => {
        sleeps += 1;
      },
    });
    return { reads, sleeps: () => sleeps };
  }

  it("confirms a rendered error that the transcript also shows as the CLI's API error", async () => {
    const probe = inject(apiErrorTail);
    expect(
      await confirmRenderedSignatureError({ output: ERROR_LINE, sessionId: "sid", cwd: "/w" }),
    ).toBe(true);
    expect(probe.reads).toEqual(["/w:sid"]);
  });

  it("does NOT confirm when the model's reply quotes the error as its last line", async () => {
    const probe = inject(modelTextTail);
    const reply = `Here is the log you asked about:\n${ERROR_LINE}`;
    expect(
      await confirmRenderedSignatureError({ output: reply, sessionId: "sid", cwd: "/w" }),
    ).toBe(false);
    expect(probe.sleeps()).toBe(2); // asked three times, in case the transcript lags
  });

  it("does not confirm without a transcript, or without a known session id", async () => {
    inject(null);
    expect(
      await confirmRenderedSignatureError({ output: ERROR_LINE, sessionId: "sid", cwd: "/w" }),
    ).toBe(false);
    const probe = inject(apiErrorTail);
    for (const sessionId of [undefined, "unknown", ""]) {
      expect(
        await confirmRenderedSignatureError({ output: ERROR_LINE, sessionId, cwd: "/w" }),
      ).toBe(false);
    }
    expect(probe.reads).toEqual([]);
  });

  it("does not even read the transcript when the output does not end in the error", async () => {
    const probe = inject(apiErrorTail);
    expect(
      await confirmRenderedSignatureError({ output: "all good", sessionId: "sid", cwd: "/w" }),
    ).toBe(false);
    expect(probe.reads).toEqual([]);
  });
});
