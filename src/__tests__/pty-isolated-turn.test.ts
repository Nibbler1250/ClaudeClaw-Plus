/**
 * #581 cp4: an untrusted one-shot's turn is observed through the SAME transcript observer as a
 * trusted one, reading the project directory of its own throwaway config root.
 *
 * The rule these tests pin (Terry, 2026-10-21): the screen is never evidence that a prompt was
 * accepted, that a turn finished, or of what the answer was. So the fake TUIs here (real
 * `/bin/sh` children, as in pty-false-completion.test.ts) put the screen and the transcript in
 * disagreement and check that the transcript, and only the transcript, decides.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PtyClosedError,
  PtyPromptNotAcceptedError,
  PtyTranscriptUncertainError,
  PtyTranscriptUnavailableError,
  PtyTurnFailedError,
  PtyTurnTimeoutError,
  type PtyProcess,
  type PtyProcessOptions,
  spawnPty,
} from "../runner/pty-process";
import { neutralizeFileMentions } from "../runner/pty-prompt-sanitizer";
import { resolveIsolatedProjectDir } from "../runner/pty-transcript";
import {
  append,
  assistantLine,
  CHROME_BUSY,
  CHROME_DONE,
  systemLine,
  userLine,
} from "./fixtures/fake-claude-tui";

const PROMPT = "classify this message";
const NO_SECURITY = { level: "unrestricted" as const, allowedTools: [], disallowedTools: [] };

let dir: string;
let cwd: string;
let root: string;
let project: string;
const spawned: PtyProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pty-isolated-turn-"));
  cwd = join(dir, "cwd");
  root = join(dir, "throwaway-config");
  mkdirSync(cwd);
  project = resolveIsolatedProjectDir({ cwd, env: { CLAUDE_CONFIG_DIR: root } }) as string;
});
afterEach(async () => {
  for (const proc of spawned.splice(0)) await proc.dispose().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
});

/** The screen's answer-shaped paint. The transcript, not this, is what a turn is judged on. */
const screenAnswer = (text: string): string => `printf '\\342\\227\\217 ${text}\\n'`;

/** A fake claude: reads the pasted line, then runs `steps` against the isolated project directory. */
function script(...steps: string[]): string {
  return ["IFS= read -r l", `mkdir -p '${project}'`, ...steps, "exec cat"].join("; ");
}

const file = (name: string): string => join(project, name);

async function spawnIsolated(
  body: string,
  over: Partial<PtyProcessOptions> = {},
): Promise<PtyProcess> {
  const proc = await spawnPty({
    sessionId: "",
    cwd,
    isolation: "untrusted",
    env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: root },
    security: NO_SECURITY,
    _skipReadySettle: true,
    _commandOverride: "/bin/sh",
    _argsOverride: ["-c", body],
    quietWindowMs: 50,
    settleCapMs: 300,
    submitConfirmMs: 250,
    ...over,
  });
  spawned.push(proc);
  return proc;
}

async function outcome(
  body: string,
  turn: { prompt?: string; timeoutMs?: number } = {},
  over: Partial<PtyProcessOptions> = {},
): Promise<{ text?: string; err?: unknown }> {
  const proc = await spawnIsolated(body, over);
  try {
    const result = await proc.runTurn(turn.prompt ?? PROMPT, { timeoutMs: turn.timeoutMs ?? 4000 });
    return { text: result.text };
  } catch (err) {
    return { err };
  }
}

describe("the transcript decides, not the screen", () => {
  test("a JSONL answer that differs from the screen is returned exactly", async () => {
    const out = await outcome(
      script(
        `printf '${CHROME_BUSY}'`,
        append(file("s.jsonl"), userLine(PROMPT)),
        // The screen shows an answer and goes quiet first; the transcript lags behind it.
        screenAnswer("SCREEN-ANSWER-NOT-THIS-ONE"),
        `printf '${CHROME_DONE}'`,
        "sleep 0.5",
        append(file("s.jsonl"), assistantLine("  the JSONL answer, exactly\n")),
        append(file("s.jsonl"), systemLine("turn_duration")),
      ),
    );
    expect(out.err).toBeUndefined();
    // Went red (the screen's "SCREEN-ANSWER-NOT-THIS-ONE" came back) with a quiet screen holding
    // an answer-shaped line allowed to complete the turn, ahead of the lagging transcript.
    expect(out.text).toBe("  the JSONL answer, exactly\n");
  });

  test("a plausible answer on the screen with no JSONL at all is a failure", async () => {
    const out = await outcome(
      script(
        `printf '${CHROME_BUSY}'`,
        screenAnswer("A-PERFECTLY-PLAUSIBLE-ANSWER"),
        `printf '${CHROME_DONE}'`,
      ),
    );
    // Went red (text "A-PERFECTLY-PLAUSIBLE-ANSWER") with the same screen-success path re-enabled.
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
    expect(String((out.err as Error).message)).not.toContain("PLAUSIBLE");
    // The project directory is empty: there was no session file to read.
    expect(existsSync(file("s.jsonl"))).toBe(false);
  });

  test("a plausible answer on the screen over a transcript that only has the prompt is not a success", async () => {
    const out = await outcome(
      script(
        append(file("s.jsonl"), userLine(PROMPT)),
        screenAnswer("A-PERFECTLY-PLAUSIBLE-ANSWER"),
        `printf '${CHROME_DONE}'`,
      ),
      { timeoutMs: 800 },
    );
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyTurnTimeoutError);
  });

  test("a reply with no turn boundary after it is uncertain at the deadline, never a success", async () => {
    const out = await outcome(
      script(
        append(file("s.jsonl"), userLine(PROMPT)),
        append(file("s.jsonl"), assistantLine("a reply that may still gain blocks")),
        `printf '${CHROME_DONE}'`,
      ),
      { timeoutMs: 800 },
    );
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyTranscriptUncertainError);
  });

  test("an answer already in the transcript before the send is not this turn's", async () => {
    // Written here, before the spawn, so it is certainly there when the turn is marked.
    mkdirSync(project, { recursive: true });
    writeFileSync(
      file("old.jsonl"),
      `${[userLine(PROMPT), assistantLine("STALE reply to the same prompt"), systemLine("turn_duration")].join("\n")}\n`,
    );
    const out = await outcome(
      ["IFS= read -r l", `printf '${CHROME_DONE}'`, "exec cat"].join("; "),
      {
        timeoutMs: 800,
      },
    );
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
  });
});

describe("the exact bytes written", () => {
  const MENTION = "mail a@b.co about it";

  test("a user record with the neutralised text is this prompt", async () => {
    const out = await outcome(
      script(
        append(file("s.jsonl"), userLine(neutralizeFileMentions(MENTION))),
        append(file("s.jsonl"), assistantLine("sent")),
        append(file("s.jsonl"), systemLine("turn_duration")),
      ),
      { prompt: MENTION },
    );
    // Went red (the prompt was never accepted) with the observer handed the pre-neutralisation
    // prompt instead of the bytes written.
    expect(out.err).toBeUndefined();
    expect(out.text).toBe("sent");
  });

  test("a user record with the pre-neutralisation text is not", async () => {
    const out = await outcome(
      script(
        append(file("s.jsonl"), userLine(MENTION)),
        append(file("s.jsonl"), assistantLine("sent")),
        append(file("s.jsonl"), systemLine("turn_duration")),
      ),
      { prompt: MENTION, timeoutMs: 1500 },
    );
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
  });
});

describe("fail closed", () => {
  test("two session files that record the prompt are ambiguous, with no answer", async () => {
    const out = await outcome(
      script(
        append(file("a.jsonl"), userLine(PROMPT)),
        append(file("b.jsonl"), userLine(PROMPT)),
        append(file("a.jsonl"), assistantLine("from a")),
        append(file("a.jsonl"), systemLine("turn_duration")),
      ),
    );
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyTurnFailedError);
    expect((out.err as PtyTurnFailedError).kind).toBe("ambiguous");
  });

  test("an API error record fails the turn with the CLI's own text", async () => {
    const apiError = JSON.stringify({
      type: "assistant",
      isApiErrorMessage: true,
      message: {
        id: "e",
        model: "<synthetic>",
        content: [{ type: "text", text: "API Error: 400" }],
      },
    });
    const started = Date.now();
    const out = await outcome(
      script(append(file("s.jsonl"), userLine(PROMPT)), append(file("s.jsonl"), apiError)),
      { timeoutMs: 10_000 },
    );
    expect(out.err).toBeInstanceOf(PtyTurnFailedError);
    expect((out.err as PtyTurnFailedError).kind).toBe("api-error");
    // At once: the error is the end of the turn, not something to wait out.
    expect(Date.now() - started).toBeLessThan(2500);
  });

  test("the deadline ends a turn that never gets a reply", async () => {
    const started = Date.now();
    const out = await outcome(script(append(file("s.jsonl"), userLine(PROMPT))), {
      timeoutMs: 500,
    });
    expect(out.err).toBeInstanceOf(PtyTurnTimeoutError);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  test("retiring the process mid-turn ends it as closed, with no answer", async () => {
    const proc = await spawnIsolated(script(append(file("s.jsonl"), userLine(PROMPT))));
    const turn = proc.runTurn(PROMPT, { timeoutMs: 10_000 });
    setTimeout(() => void proc.dispose(), 250);
    await expect(turn).rejects.toBeInstanceOf(PtyClosedError);
  });

  test("a turn with no throwaway config root is refused before anything is written", async () => {
    const sink = join(dir, "wire.txt");
    const proc = await spawnIsolated(`exec cat > '${sink}'`, { env: { PATH: "/usr/bin:/bin" } });
    await expect(proc.runTurn(PROMPT, { timeoutMs: 500 })).rejects.toBeInstanceOf(
      PtyTranscriptUnavailableError,
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(readFileSync(sink, "utf8")).toBe("");
  });

  test("a caller's transcriptPath is not taken by an untrusted process", async () => {
    // The operator's session file would otherwise be credited with the turn.
    const operatorSession = join(dir, "operator-session.jsonl");
    const out = await outcome(
      [
        "IFS= read -r l",
        append(operatorSession, userLine(PROMPT)),
        append(operatorSession, assistantLine("OPERATOR session answer")),
        append(operatorSession, systemLine("turn_duration")),
        "exec cat",
      ].join("; "),
      { timeoutMs: 800 },
      { transcriptPath: operatorSession },
    );
    expect(out.text).toBeUndefined();
    expect(out.err).toBeInstanceOf(PtyPromptNotAcceptedError);
  });
});
