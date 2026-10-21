/**
 * #562 soak: a PTY turn was reported "done" (exit 0) when the prompt never
 * reached the model. The paste sat unsubmitted in claude's input box; the TUI
 * repainted the previous conversation (its `✻ … done 16:36` summary line and the
 * idle footer); the parser read that as the end of THIS turn, the sentinel
 * echoed into the input box, and the old scrollback came back as the answer.
 *
 * The fake TUIs below are `/bin/sh` scripts. The kernel's cooked-mode echo stands
 * in for claude's input box: whatever we write (the paste, a retry CR, the
 * sentinel) is echoed straight back, as the real TUI does. Glyphs are octal
 * (`/bin/sh` is dash on CI and its printf has no `\xHH`):
 *   ✻ \342\234\273   · \302\267   ● \342\227\217   ◐ \342\227\220   ✳ \342\234\263
 */
import { describe, expect, test } from "bun:test";
import { PtyPromptNotAcceptedError, spawnPty, type PtyProcessOptions } from "../runner/index";
import type { SecurityConfig } from "../config";

const NO_SECURITY: SecurityConfig = {
  level: "unrestricted",
  allowedTools: [],
  disallowedTools: [],
};

function opts(script: string, over: Partial<PtyProcessOptions> = {}): PtyProcessOptions {
  return {
    sessionId: "",
    cwd: "/tmp",
    security: NO_SECURITY,
    env: { ...process.env } as Record<string, string>,
    agentName: "test",
    _skipReadySettle: true,
    _skipClaudeArgs: true,
    _commandOverride: "/bin/sh",
    _argsOverride: ["-c", script],
    cols: 80,
    rows: 24,
    quietWindowMs: 50,
    sentinelMaxWaitMs: 3000,
    // Longer than quietWindowMs + the echo, so a turn the OLD code wrongly
    // completes finishes before this timer could reject it: a test that goes
    // red under fault injection must go red because of the fault, not a race.
    submitConfirmMs: 400,
    ...over,
  };
}

/** What a resumed session repaints: the previous turn's answer and its idle chrome. */
const STALE =
  "\\n\\342\\227\\217 OLD-ANSWER-R15x\\n\\342\\234\\273 Saut\\303\\251ed for 1s \\302\\267 done 16:36\\n shift+tab to cycle\\n";
/** The turn really starts: running window title, spinner, busy footer (captured shape, #369). */
const BUSY =
  "\\033]0;\\342\\227\\220 Work\\007\\342\\234\\273 Working\\342\\200\\246\\n\\302\\267 esc to interrupt\\n";
/** The answer, then the completion chrome claude paints. */
const ANSWER = "\\342\\227\\217 NEW-ANSWER-R17x\\n";
const DONE =
  "\\033]0;\\342\\234\\263 Work\\007\\342\\234\\273 Saut\\303\\251ed for 2s \\302\\267 done 16:40\\n";

describe("#562 — a turn completes only on evidence the prompt was accepted", () => {
  test("stale footer + summary on screen, paste never submitted: the turn is NOT done", async () => {
    // Reads the paste line, repaints the old screen, then ignores everything.
    const proc = await spawnPty(opts(`read _l; printf '${STALE}'; sleep 8`));
    let outcome: { text?: string; clean?: boolean; err?: unknown } = {};
    try {
      const r = await proc.runTurn("R17x please", { timeoutMs: 5000 });
      outcome = { text: r.text, clean: r.cleanBoundary };
    } catch (err) {
      outcome = { err };
    }
    await proc.dispose();
    // Fault: drop the turn-started requirement from `tick` and this resolves done
    // with `OLD-ANSWER-R15x` as the answer, which is exactly what the soak saw.
    expect(outcome.text).toBeUndefined();
    expect(outcome.err).toBeInstanceOf(PtyPromptNotAcceptedError);
  });

  test("paste swallowed once, the submit retry lands: completes with only the new output", async () => {
    // First line (paste + CR) is swallowed; the retry CR arrives as the next, empty line.
    const proc = await spawnPty(
      opts(
        `read _l1; printf '${STALE}'; read _l2; printf '${BUSY}'; sleep 0.2; printf '${ANSWER}${DONE}'; sleep 8`,
      ),
    );
    const result = await proc.runTurn("R17x please", { timeoutMs: 5000 });
    await proc.dispose();
    // Fault: delete the retry and the second `read` never returns, so the turn is
    // rejected as not accepted instead of completing.
    expect(result.cleanBoundary).toBe(true);
    expect(result.text).toContain("NEW-ANSWER-R17x");
    expect(result.text).not.toContain("OLD-ANSWER-R15x");
  });

  test("output isolation: the previous turn's answer, repainted before this turn starts, is not the result", async () => {
    // Accepted on the first CR, but the old screen is repainted first and the new
    // answer carries no line-anchored `●`, so the extractor's "last marker" is the OLD one.
    const proc = await spawnPty(
      opts(
        `read _l; printf '${STALE}'; sleep 0.3; printf '${BUSY}'; sleep 0.2; printf 'RESULT-R17x\\n${DONE}'; sleep 8`,
      ),
    );
    const result = await proc.runTurn("R17x please", { timeoutMs: 5000 });
    await proc.dispose();
    // Fault: slice from the send offset instead of the turn-start edge and the
    // extractor returns `OLD-ANSWER-R15x` here.
    expect(result.text).toContain("RESULT-R17x");
    expect(result.text).not.toContain("OLD-ANSWER-R15x");
  });

  test("resumed session: a repaint of thirty old turns is neither the answer nor mistaken for completion", async () => {
    // A long-resumed conversation: every old turn leaves a `●` answer and a done
    // summary on screen, and the whole lot is repainted when the paste lands.
    const old = Array.from(
      { length: 30 },
      (_, i) =>
        `\\n\\342\\227\\217 OLD-R${i}x\\n\\342\\234\\273 Saut\\303\\251ed for ${i + 1}s \\302\\267 done 09:${String(i).padStart(2, "0")}`,
    ).join("");
    const swallowed = await spawnPty(
      opts(`read _l; printf '${old}\\n shift+tab to cycle\\n'; sleep 8`),
    );
    let err: unknown;
    try {
      await swallowed.runTurn("R17x please", { timeoutMs: 5000 });
    } catch (e) {
      err = e;
    }
    await swallowed.dispose();
    expect(err).toBeInstanceOf(PtyPromptNotAcceptedError);

    const accepted = await spawnPty(
      opts(
        `read _l; printf '${old}\\n shift+tab to cycle\\n'; sleep 0.3; printf '${BUSY}'; sleep 0.2; printf 'RESULT-R17x\\n${DONE}'; sleep 8`,
      ),
    );
    const result = await accepted.runTurn("R17x please", { timeoutMs: 5000 });
    await accepted.dispose();
    expect(result.text).toContain("RESULT-R17x");
    expect(result.text).not.toMatch(/OLD-R\d+x/);
  });

  test("a prompt accepted on the first CR needs no retry", async () => {
    // The healthy path must not regress. `read -t` waits for a second line: a retry
    // CR sent after a healthy submit would make it return and print EXTRA-CR-SEEN.
    const proc = await spawnPty(
      opts(
        `read _l; printf '${BUSY}${ANSWER}${DONE}'; read -t 2 _l2 && echo EXTRA-CR-SEEN; sleep 8`,
        {
          submitConfirmMs: 150,
        },
      ),
    );
    const result = await proc.runTurn("R17x please", { timeoutMs: 5000 });
    // Let a (wrong) retry timer fire before looking: it would land in the next turn's input.
    await new Promise((r) => setTimeout(r, 400));
    await proc.dispose();
    expect(result.cleanBoundary).toBe(true);
    expect(result.text).toContain("NEW-ANSWER-R17x");
    expect(result.text).not.toContain("EXTRA-CR-SEEN");
  });

  test("onChunk is not fed the stale repaint of a turn that never started", async () => {
    const proc = await spawnPty(opts(`read _l; printf '${STALE}'; sleep 8`));
    const chunks: string[] = [];
    await proc
      .runTurn("R17x please", { timeoutMs: 5000, onChunk: (c) => chunks.push(c) })
      .catch(() => undefined);
    await proc.dispose();
    // Fault: stream from the send instead of from the edge and the old answer
    // reaches the caller (Discord/Telegram) as if it were this turn's output.
    expect(chunks.join("")).not.toContain("OLD-ANSWER-R15x");
  });
});
