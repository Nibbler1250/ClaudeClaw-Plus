/**
 * #562 soak and round 2: a PTY turn was reported "done" (exit 0) when the prompt never
 * reached the model, then, after the screen-based fix, could still be forged by a prompt's
 * own echo, scrollback, or a chunk boundary.
 *
 * The rule these tests pin: the SCREEN is never evidence that a prompt was accepted, that
 * a turn finished, or of what the answer was. Only the session transcript is. So most
 * tests here put the screen and the transcript in disagreement (done chrome with an empty
 * transcript, or a finished transcript under chaotic chrome) and check the transcript wins.
 *
 * The fake TUIs are real `/bin/sh` children that write a real JSONL file
 * (`fixtures/fake-claude-tui.ts`). The kernel's cooked-mode echo stands in for claude's
 * input box. No test gets its acceptance from the prompt's own echo: the prompts carry no
 * marker phrase, except the forgery tests, which exist to show the phrase proves nothing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecurityConfig } from "../config";
import {
  PtyPromptNotAcceptedError,
  PtyTranscriptUnavailableError,
  PtyTurnTimeoutError,
  type PtyProcessOptions,
  spawnPty,
} from "../runner/index";
import {
  append,
  appendRaw,
  assistantLine,
  CHROME_BUSY,
  CHROME_DONE,
  CHROME_STALE,
  fakeTurn,
  systemLine,
  type TempTranscript,
  tempTranscript,
  userLine,
} from "./fixtures/fake-claude-tui";

const NO_SECURITY: SecurityConfig = {
  level: "unrestricted",
  allowedTools: [],
  disallowedTools: [],
};
const PROMPT = "R17x please";

const made: TempTranscript[] = [];
function tx(seed = ""): TempTranscript {
  const t = tempTranscript();
  made.push(t);
  if (seed) writeFileSync(t.path, seed);
  return t;
}
afterEach(() => {
  delete process.env.CLAUDECLAW_PTY_DUMP;
  while (made.length) made.pop()?.cleanup();
});

function opts(
  script: string,
  t: TempTranscript,
  over: Partial<PtyProcessOptions> = {},
): PtyProcessOptions {
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
    transcriptPath: t.path,
    cols: 80,
    rows: 24,
    quietWindowMs: 50,
    settleCapMs: 400,
    // Longer than the fakes' think time, so a turn that wrongly "completes" finishes before
    // this timer could reject it: a test that goes red under a fault must go red because of
    // the fault, not a race.
    submitConfirmMs: 400,
    ...over,
  };
}

async function runOutcome(
  script: string,
  t: TempTranscript,
  over: Partial<PtyProcessOptions> = {},
  turn: {
    prompt?: string;
    timeoutMs?: number;
    allowReplCommand?: boolean;
    onChunk?: (c: string) => void;
  } = {},
): Promise<{ text?: string; err?: unknown }> {
  const proc = await spawnPty(opts(script, t, over));
  try {
    const r = await proc.runTurn(turn.prompt ?? PROMPT, {
      timeoutMs: turn.timeoutMs ?? 5000,
      allowReplCommand: turn.allowReplCommand,
      onChunk: turn.onChunk,
    });
    return { text: r.text };
  } catch (err) {
    return { err };
  } finally {
    await proc.dispose();
  }
}

/** Run with the PTY trace on; returns the trace text. */
async function withTrace<T>(body: () => Promise<T>): Promise<{ value: T; wire: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pty-562-"));
  const trace = join(dir, "trace.log");
  process.env.CLAUDECLAW_PTY_DUMP = trace;
  try {
    const value = await body();
    return { value, wire: readFileSync(trace, "utf8") };
  } finally {
    delete process.env.CLAUDECLAW_PTY_DUMP;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#562 — the screen is never evidence the prompt was accepted", () => {
  // Each phrase is something the old detector read as "a turn is running". The prompt
  // ECHOES it (the kernel stands in for the input box) and the repaint paints it next to
  // the old conversation's done chrome, while the transcript holds OLD assistant text that
  // contains it too. None of that is a new entry for this prompt.
  for (const phrase of ["esc to interrupt", "esc cancel", "Compacting conversation"]) {
    test(`a prompt and old assistant text containing "${phrase}": the turn is NOT done`, async () => {
      const t = tx(`${assistantLine(`OLD text about ${phrase}`)}\n`);
      const script = `IFS= read -r l; printf '${CHROME_STALE}'; printf '${phrase} ${CHROME_BUSY}${CHROME_DONE}'; sleep 8`;
      const out = await runOutcome(
        script,
        t,
        { submitConfirmMs: 150 },
        { prompt: `Explain ${phrase}.` },
      );
      // Fault: treat a screen marker as acceptance again and this resolves with stale text.
      expect(out.text).toBeUndefined();
      expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
    });
  }

  test("running chrome, an answer and done chrome on screen, an empty transcript: NOT done", async () => {
    const t = tx();
    const script = `IFS= read -r l; printf '${CHROME_BUSY}'; printf '\\342\\227\\217 SCREEN-ANSWER\\n${CHROME_DONE}'; sleep 8`;
    const out = await runOutcome(script, t, { submitConfirmMs: 150 });
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
  });

  test("the transcript holds a user entry for something ELSE: not accepted, and the error says so", async () => {
    const t = tx();
    const script = `IFS= read -r l; ${append(t.path, userLine("a different prompt"))}; printf '${CHROME_BUSY}${CHROME_DONE}'; sleep 8`;
    const out = await runOutcome(script, t, { submitConfirmMs: 150 });
    expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
    expect((out.err as Error).message).toContain("did not match this prompt");
  });

  test("an earlier identical prompt and its answer in the transcript are not this turn", async () => {
    const t = tx(`${userLine(PROMPT)}\n${assistantLine("OLD-ANSWER-R15x")}\n`);
    const script = `IFS= read -r l; printf '${CHROME_STALE}'; sleep 8`;
    const out = await runOutcome(script, t, { submitConfirmMs: 150 });
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
  });

  test("onChunk is not fed the stale repaint of a turn that never started", async () => {
    const t = tx();
    const chunks: string[] = [];
    await runOutcome(
      `IFS= read -r l; printf '${CHROME_STALE}'; sleep 8`,
      t,
      { submitConfirmMs: 150 },
      {
        onChunk: (c) => chunks.push(c),
      },
    );
    // Fault: stream the screen again and the old answer reaches Discord/Telegram.
    expect(chunks.join("")).toBe("");
  });

  test("a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it", async () => {
    // After the retry CR the fake goes raw and records the next byte it gets. Ctrl-U (0x15)
    // is what empties claude's input box.
    const t = tx();
    const dir = mkdtempSync(join(tmpdir(), "pty-562-"));
    const seen = join(dir, "seen.hex");
    try {
      const out = await runOutcome(
        `IFS= read -r l1; printf '${CHROME_STALE}'; IFS= read -r l2; stty raw -echo; dd bs=1 count=1 2>/dev/null | od -An -tx1 > ${seen}; sleep 8`,
        t,
        { submitConfirmMs: 150 },
      );
      expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
      await new Promise((r) => setTimeout(r, 300));
      // Fault: skip the clear and the fake never receives a byte, so this is empty.
      expect(readFileSync(seen, "utf8").trim()).toBe("15");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#562 — a turn is over only when the transcript says so", () => {
  test("accepted, and the screen shows the answer and done chrome, but the reply has no stop: NOT done", async () => {
    const t = tx();
    const script = [
      "IFS= read -r l",
      `printf '${CHROME_BUSY}'`,
      append(t.path, userLine(PROMPT)),
      append(t.path, assistantLine("partial", { stop: null })),
      `printf '\\342\\227\\217 SCREEN-SAYS-DONE\\n${CHROME_DONE}'`,
      "sleep 8",
    ].join("; ");
    const out = await runOutcome(script, t, {}, { timeoutMs: 1500 });
    // Fault: let done chrome complete the turn and this resolves instead of timing out.
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyTurnTimeoutError);
  });

  test("the answer is the transcript's, not the screen's", async () => {
    const t = tx();
    const script = `${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "TRANSCRIPT-ANSWER" })}; printf '\\342\\227\\217 SCREEN-ANSWER\\n'; sleep 8`;
    const out = await runOutcome(script, t);
    expect(out.text).toBe("TRANSCRIPT-ANSWER");
  });

  test("output isolation: the previous turn's answer, repainted before this turn, is not the result", async () => {
    const t = tx(`${userLine("earlier")}\n${assistantLine("OLD-ANSWER-R15x")}\n`);
    const script = `IFS= read -r l; printf '${CHROME_STALE}'; sleep 0.3; ${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "RESULT-R17x" }).replace("IFS= read -r l; ", "")}; sleep 8`;
    const out = await runOutcome(script, t);
    expect(out.text).toBe("RESULT-R17x");
  });

  test("resumed session: thirty old turns repainted are neither the answer nor mistaken for completion", async () => {
    const old = Array.from(
      { length: 30 },
      (_, i) =>
        `\\n\\342\\227\\217 OLD-R${i}x\\n\\342\\234\\273 Saut\\303\\251ed for ${i + 1}s \\302\\267 done 09:${String(i).padStart(2, "0")}`,
    ).join("");
    const seed = Array.from(
      { length: 30 },
      (_, i) => `${userLine(`q${i}`)}\n${assistantLine(`OLD-R${i}x`)}`,
    ).join("\n");
    const swallowed = tx(`${seed}\n`);
    const out1 = await runOutcome(
      `IFS= read -r l; printf '${old}\\n shift+tab to cycle\\n'; sleep 8`,
      swallowed,
      {
        submitConfirmMs: 150,
      },
    );
    expect(out1.err).toBeInstanceOf(PtyPromptNotAcceptedError);

    const accepted = tx(`${seed}\n`);
    const script = `IFS= read -r l; printf '${old}\\n shift+tab to cycle\\n'; sleep 0.3; ${fakeTurn({ tx: accepted.path, prompt: PROMPT, answer: "RESULT-R17x" }).replace("IFS= read -r l; ", "")}; sleep 8`;
    const out2 = await runOutcome(script, accepted);
    expect(out2.text).toBe("RESULT-R17x");
    expect(out2.text).not.toMatch(/OLD-R\d+x/);
  });

  test("onChunk streams the assistant's own text from the transcript", async () => {
    const t = tx();
    const chunks: string[] = [];
    const script = `${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "STREAMED" })}; sleep 8`;
    const out = await runOutcome(script, t, {}, { onChunk: (c) => chunks.push(c) });
    expect(out.text).toBe("STREAMED");
    expect(chunks.join("")).toBe("STREAMED");
  });
});

describe("#562 — the same transcript, delivered in any shape, gives the same verdict and answer", () => {
  const A = assistantLine("FIRST ", { id: "m1", stop: null });
  const B = assistantLine("SECOND ", { id: "m1", stop: null });
  const C = assistantLine("THIRD", { id: "m1", stop: "end_turn" });
  const user = userLine(PROMPT);
  const whole = `${user}\n${A}\n${B}\n${C}\n`;

  // Each partition tears the stream somewhere different, JSON lines included.
  const partitions: Array<[string, string[]]> = [
    ["one write", [whole]],
    ["user, then the three blocks in separate writes", [`${user}\n`, `${A}\n`, `${B}\n`, `${C}\n`]],
    [
      "torn mid-line, resumed later",
      [
        whole.slice(0, 40),
        whole.slice(40, whole.indexOf("SECOND") + 3),
        whole.slice(whole.indexOf("SECOND") + 3),
      ],
    ],
    [
      "byte-sized fragments over the last block",
      [whole.slice(0, whole.length - 12), ...whole.slice(-12).split("")],
    ],
  ];
  for (const [name, parts] of partitions) {
    test(`${name}`, async () => {
      const t = tx();
      const writes = parts.map((p) => `${appendRaw(t.path, p)}; sleep 0.12`).join("; ");
      const script = `IFS= read -r l; printf '${CHROME_BUSY}'; ${writes}; printf '${CHROME_DONE}'; sleep 8`;
      const out = await runOutcome(script, t);
      // Fault: drop the carry of a torn trailing line and the answer comes back short.
      expect(out.err).toBeUndefined();
      expect(out.text).toBe("FIRST SECOND THIRD");
    });
  }
});

describe("#562 — acceptance does not depend on the screen painting anything", () => {
  test("a fast turn that paints NO running chrome is accepted, once, and not re-submitted", async () => {
    const t = tx();
    const script = `IFS= read -r l; ${append(t.path, userLine(PROMPT))}; ${append(t.path, assistantLine("QUICK"))}; sleep 8`;
    const { value, wire } = await withTrace(() => runOutcome(script, t, { submitConfirmMs: 150 }));
    expect(value.err).toBeUndefined();
    expect(value.text).toBe("QUICK");
    expect(wire).toContain("write prompt");
    // Fault: key the retry on a screen marker and a fast turn is re-submitted.
    expect(wire).not.toContain("retry submit");
  });

  test("chrome that renders differently (SGR inside the footer) changes nothing", async () => {
    const t = tx();
    const sgr = "\\033[2mesc\\033[0m \\033[2mto\\033[0m \\033[2minterrupt\\033[0m\\n";
    const script = `IFS= read -r l; printf '${sgr}'; ${append(t.path, userLine(PROMPT))}; sleep 0.3; ${append(t.path, assistantLine("OK"))}; sleep 8`;
    const { value, wire } = await withTrace(() => runOutcome(script, t, { submitConfirmMs: 150 }));
    expect(value.text).toBe("OK");
    expect(wire).not.toContain("retry submit");
  });

  test("/compact: accepted by its command entry, ended by compact_boundary, not re-submitted or rejected", async () => {
    const t = tx();
    // The compaction outlasts submitConfirmMs, as a real one does, and paints no running marker.
    const cmd = "<command-name>/compact</command-name>\n<command-message>compact</command-message>";
    const script = `IFS= read -r l; ${append(t.path, userLine(cmd))}; sleep 0.6; ${append(t.path, systemLine("compact_boundary", "Conversation compacted"))}; sleep 8`;
    const { value, wire } = await withTrace(() =>
      runOutcome(
        script,
        t,
        { submitConfirmMs: 200 },
        { prompt: "/compact", allowReplCommand: true },
      ),
    );
    expect(value.err).toBeUndefined();
    expect(value.text).toBe("Conversation compacted");
    expect(wire).not.toContain("retry submit");
  });
});

describe("#562 — the submit retry", () => {
  test("paste swallowed once, the retry lands: completes with only the new output", async () => {
    const t = tx(`${assistantLine("OLD-ANSWER-R15x")}\n`);
    const script = `IFS= read -r l1; printf '${CHROME_STALE}'; IFS= read -r l2; ${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "NEW-ANSWER-R17x" }).replace("IFS= read -r l; ", "")}; sleep 8`;
    const out = await runOutcome(script, t, { submitConfirmMs: 200 });
    // Fault: delete the retry write; the second `read` never returns, so the turn is
    // rejected as not accepted instead of completing.
    expect(out.text).toBe("NEW-ANSWER-R17x");
  });

  test("evidence that arrives AFTER the confirm deadline: no duplicate submission", async () => {
    const t = tx();
    const dir = mkdtempSync(join(tmpdir(), "pty-562-"));
    const reads = join(dir, "reads.log");
    try {
      // Accepted at once, but the CLI is slow to write the entry: past the first deadline
      // (200 ms), before the second (400 ms). The fake logs every line it is handed, so the
      // CR count and the number of times the prompt text arrived are both observable.
      const script = [
        `IFS= read -r l1; printf '%s\\n' "$l1" >> ${reads}`,
        "sleep 0.3",
        `IFS= read -r l2; printf '%s\\n' "$l2" >> ${reads}`,
        append(t.path, userLine(PROMPT)),
        append(t.path, assistantLine("LATE-BUT-ONCE")),
        "sleep 8",
      ].join("; ");
      const out = await runOutcome(script, t, { submitConfirmMs: 200 });
      expect(out.err).toBeUndefined();
      expect(out.text).toBe("LATE-BUT-ONCE");
      const lines = readFileSync(reads, "utf8")
        .split("\n")
        .filter((x, i, a) => i < a.length - 1);
      // One paste (the prompt text, once) and exactly one bare CR. Fault: a retry that
      // re-writes the prompt makes the text appear twice.
      expect(lines.filter((x) => x.includes(PROMPT)).length).toBe(1);
      expect(lines.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a prompt accepted on the first CR, in a turn that outlasts submitConfirmMs, is never retried", async () => {
    const t = tx();
    const script = `${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "SLOW", think: 0.6 })}; sleep 8`;
    const { value, wire } = await withTrace(() => runOutcome(script, t, { submitConfirmMs: 150 }));
    expect(value.text).toBe("SLOW");
    expect(wire).toContain("write prompt");
    // Fault: let the confirm timer ignore the transcript and this line appears.
    expect(wire).not.toContain("retry submit");
  });

  test("evidence after BOTH deadlines is too late: the turn fails, it does not wait for ever", async () => {
    const t = tx();
    const script = `IFS= read -r l1; sleep 1; ${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "TOO-LATE" }).replace("IFS= read -r l; ", "")}; sleep 8`;
    const out = await runOutcome(script, t, { submitConfirmMs: 150 });
    expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
  });
});

describe("#562 — the screen's only say is timing, and it can only delay", () => {
  test("a screen that never goes quiet still resolves with the transcript answer after the cap", async () => {
    const t = tx();
    // Paints a dot every 50 ms for as long as it lives: no quiet window ever opens.
    const script = `${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "NOISY-SCREEN" })}; while true; do printf .; sleep 0.05; done`;
    const t0 = Date.now();
    const out = await runOutcome(script, t, { quietWindowMs: 200, settleCapMs: 400 });
    // Fault: let the quiet window gate completion and this is a timeout, not a result.
    expect(out.err).toBeUndefined();
    expect(out.text).toBe("NOISY-SCREEN");
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test("a quiet screen resolves without waiting out the cap", async () => {
    const t = tx();
    const script = `${fakeTurn({ tx: t.path, prompt: PROMPT, answer: "QUIET" })}; sleep 8`;
    const t0 = Date.now();
    const out = await runOutcome(script, t, { quietWindowMs: 50, settleCapMs: 4000 });
    expect(out.text).toBe("QUIET");
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});

describe("#562 — a process with no transcript cannot succeed", () => {
  test("an untrusted PTY turn errors before anything is written and never resolves from the screen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pty-562-"));
    const got = join(dir, "got.log");
    try {
      // The screen would happily "complete" this turn: it paints everything, as soon as it
      // sees any input at all. It must never see any.
      const t = tx();
      const script = `: > ${got}; IFS= read -r l && printf 'got\\n' >> ${got}; printf '${CHROME_BUSY}\\342\\227\\217 SCREEN\\n${CHROME_DONE}'; sleep 8`;
      const { transcriptPath: _omit, ...rest } = opts(script, t, { isolation: "untrusted" });
      const proc = await spawnPty(rest);
      const err = await proc.runTurn(PROMPT, { timeoutMs: 3000 }).then(
        () => null,
        (e: unknown) => e,
      );
      await new Promise((r) => setTimeout(r, 200));
      await proc.dispose();
      // Fault: drop the refusal and the screen path resolves (or the fake logs the prompt).
      expect(err).toBeInstanceOf(PtyTranscriptUnavailableError);
      expect((err as Error).message).toContain("--no-session-persistence");
      expect(readFileSync(got, "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hooked process given no transcriptPath is refused the same way", async () => {
    const t = tx();
    const { transcriptPath: _omit, ...rest } = opts("sleep 8", t);
    const proc = await spawnPty(rest);
    const err = await proc.runTurn(PROMPT, { timeoutMs: 1000 }).then(
      () => null,
      (e: unknown) => e,
    );
    await proc.dispose();
    expect(err).toBeInstanceOf(PtyTranscriptUnavailableError);
  });
});

// Silence "unused" for helpers kept for the shape of the file.
void appendFileSync;
