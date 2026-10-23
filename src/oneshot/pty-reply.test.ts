import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setSettingsFileForTests, loadSettings } from "../config.js";
import { classifierInput, classifyThreadIntent, runClassifierCall } from "../commands/discord.js";
import { spawnPty, type PtyProcessOptions } from "../runner/pty-process.js";
import {
  __resetSupervisorForTests,
  injectOneShotTrustForTests,
  injectSpawnPty,
  runOnceOnPty,
} from "../runner/pty-supervisor.js";
import {
  append,
  assistantLine,
  CHROME_BUSY,
  CHROME_DONE,
  systemLine,
  userLine,
} from "../__tests__/fixtures/fake-claude-tui.js";
import {
  preparePtyPromptForWrite,
  neutralizeFileMentions,
} from "../runner/pty-prompt-sanitizer.js";
import { untrustedPtyProjectDir } from "./pty-cleanup.js";

/**
 * #570, #581 cp4: an untrusted one-shot returns the model's reply as the common transcript
 * observer read it from the call's own throwaway root, never the screen. The fake claude is a
 * real `/bin/sh` child behind the real `PtyProcess`; its screen and its transcript disagree on
 * purpose. Nothing is read after the turn: the supervisor returns what the observer returned.
 */
const SCREEN_WITH_EXAMPLE = [
  "classify this message",
  'Return: {"action":"hire","names":["name1"]}',
  "Return ONLY valid JSON or the word null.",
].join("\n");

const PROMPT = "classify";

/** The prompt the call under test sends; the fake claude records what the process wrote of it. */
let promptUnderTest = PROMPT;
const written = (): string => neutralizeFileMentions(preparePtyPromptForWrite(promptUnderTest, {}));

let dir: string;
let savedConfig: string | undefined;
let warn: ReturnType<typeof spyOn>;
let spawns = 0;
let lastProject = "";

/** Paint the screen like a finished turn that shows the example JSON, whatever the transcript says. */
const paintScreen = (): string[] => [
  `printf '${CHROME_BUSY}'`,
  `printf '%s\\n' ${JSON.stringify(SCREEN_WITH_EXAMPLE)}`,
  `printf '${CHROME_DONE}'`,
];

const apiError = JSON.stringify({
  type: "assistant",
  isApiErrorMessage: true,
  message: {
    id: "syn",
    model: "<synthetic>",
    content: [{ type: "text", text: "API Error: 400 invalid signature" }],
  },
});

/**
 * Spawn a fake claude whose transcript lines are `steps(file)`; the real `PtyProcess` observes
 * it. `steps` is called with the session file's path inside the call's throwaway project dir.
 */
function fakeClaude(steps: (transcript: string) => string[], withScreen = true): void {
  injectSpawnPty(async (opts: PtyProcessOptions) => {
    spawns++;
    lastProject = untrustedPtyProjectDir(opts.cwd, opts.env.CLAUDE_CONFIG_DIR!);
    const transcript = join(lastProject, "reply-session.jsonl");
    const body = [
      "IFS= read -r l",
      `mkdir -p '${lastProject}'`,
      ...(withScreen ? paintScreen() : []),
      ...steps(transcript),
      "exec cat",
    ].join("; ");
    return spawnPty({
      ...opts,
      _skipReadySettle: true,
      _commandOverride: "/bin/sh",
      _argsOverride: ["-c", body],
      quietWindowMs: 50,
      settleCapMs: 300,
      submitConfirmMs: 250,
    });
  });
}

const reply = (transcript: string, text: string, id = "m1"): string[] => [
  append(transcript, userLine(written())),
  append(transcript, assistantLine(text, { id })),
  append(transcript, systemLine("turn_duration")),
];

const request = {
  route: "discord.classifier",
  prompt: PROMPT,
  isolation: "untrusted" as const,
  timeoutMs: 4000,
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pty-reply-"));
  savedConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ pty: { enabled: true } }));
  _setSettingsFileForTests(file);
  await loadSettings();
  __resetSupervisorForTests();
  injectOneShotTrustForTests(async () => {});
  warn = spyOn(console, "warn").mockImplementation(() => {});
  spawns = 0;
  lastProject = "";
  promptUnderTest = PROMPT;
});

afterEach(() => {
  warn.mockRestore();
  injectOneShotTrustForTests(null);
  injectSpawnPty(null);
  __resetSupervisorForTests();
  _setSettingsFileForTests();
  if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfig;
  rmSync(dir, { recursive: true, force: true });
});

const logged = (): string => warn.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");

describe("#570 one-shot PTY reply extraction", () => {
  it("(a) returns the exact transcript reply, not the screen text", async () => {
    fakeClaude((t) => reply(t, "hello there"));
    const result = await runOnceOnPty(request);
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe("hello there");
  });

  it("joins the text blocks of a reply split across entries of one message", async () => {
    fakeClaude((t) => [
      append(t, userLine(PROMPT)),
      append(
        t,
        assistantLine("", { id: "m1", stop: null, blocks: [{ type: "thinking", thinking: "…" }] }),
      ),
      append(t, assistantLine("first part ", { id: "m1", stop: null })),
      append(t, assistantLine("second", { id: "m1" })),
      append(t, systemLine("turn_duration")),
    ]);
    expect((await runOnceOnPty(request)).text).toBe("first part second");
  });

  it("(b) a real reply followed by an API-error entry is a failure, not a partial success", async () => {
    fakeClaude((t) => [
      append(t, userLine(PROMPT)),
      append(t, assistantLine("the real reply")),
      append(t, apiError),
    ]);
    const result = await runOnceOnPty(request);
    expect(result.exitCode).toBe(1);
    expect(result.text).toBe("");
    expect(result.diagnostic?.reason).toBe("no-reply:api-error");
    expect(logged()).toContain("api-error");
  });

  it("(c) no reply by the deadline is a timeout, with no screen text", async () => {
    fakeClaude((t) => [append(t, userLine(PROMPT))]);
    const result = await runOnceOnPty({ ...request, timeoutMs: 700 });
    expect(result.exitCode).toBe(124);
    expect(result.text).toBe("");
    expect(result.text.includes("Return")).toBe(false);
    expect(result.diagnostic?.reason).toBe("timeout");
    expect(logged().includes("Return ONLY")).toBe(false);
  });

  it("(c) a plausible answer on the screen and no transcript at all is a failure, not the screen", async () => {
    fakeClaude(() => []);
    const result = await runOnceOnPty(request);
    expect(result.exitCode).not.toBe(0);
    expect(result.text).toBe("");
    expect(result.diagnostic?.reason).toBe("no-reply:timeout");
    expect(logged().includes("Return ONLY")).toBe(false);
  });

  it("(c) a reply with no turn boundary is uncertain: a timeout, never the partial reply", async () => {
    fakeClaude((t) => [append(t, userLine(PROMPT)), append(t, assistantLine("PARTIAL reply"))]);
    const result = await runOnceOnPty({ ...request, timeoutMs: 700 });
    // Went red (exit 0, text "PARTIAL reply") with the last-assistant scan restored after the turn.
    expect(result.exitCode).toBe(124);
    expect(result.text).toBe("");
    // Whichever of the two equal deadlines (the call's and the turn's) fires first, the verdict
    // is a timeout the classifier may retry, and the partial reply is nowhere in the result.
    expect(["timeout", "no-reply:timeout"]).toContain(result.diagnostic?.reason);
  });

  it("(d) the classifier returns null when the screen holds example JSON but the reply is null", async () => {
    promptUnderTest = classifierInput("good morning everyone");
    fakeClaude((t) => reply(t, "null"));
    // The turn itself succeeded with the transcript's reply, so a null here is that reply and
    // not a failure that classifies as null.
    const { call } = await runClassifierCall(promptUnderTest);
    expect(call.exitCode).toBe(0);
    expect(call.text).toBe("null");
    expect(await classifyThreadIntent("good morning everyone")).toBeNull();
  });

  it("(d) a genuine thread message parses to the model's intent, not the example", async () => {
    promptUnderTest = classifierInput("please create a thread called release-notes");
    fakeClaude((t) => reply(t, '{"action":"hire","names":["release-notes"]}'));
    expect(await classifyThreadIntent("please create a thread called release-notes")).toEqual({
      action: "hire",
      names: ["release-notes"],
    });
  });

  it("(d) a failed turn classifies as null rather than reading the screen", async () => {
    fakeClaude((t) => [append(t, userLine(PROMPT))]);
    expect(await classifyThreadIntent("good morning everyone")).toBeNull();
  });

  it("returns the reply before cleanup removes the root, and leaves nothing behind", async () => {
    fakeClaude((t) => reply(t, "ok"));
    expect((await runOnceOnPty(request)).text).toBe("ok");
    expect(lastProject).not.toBe("");
    expect(existsSync(lastProject)).toBe(false);
  });
});

describe("the classifier's retry policy over the observer's verdicts", () => {
  const input = classifierInput("hello");

  it("retries once when the turn produced no reply (the classifier's own policy)", async () => {
    promptUnderTest = input;
    fakeClaude((t) => [append(t, userLine("a prompt that is not the one sent"))]);
    const { call, attempts } = await runClassifierCall(input);
    expect(call.exitCode).not.toBe(0);
    expect(attempts).toBe(2);
    expect(spawns).toBe(2);
  });

  it("does not retry an attribution the observer could not make (ambiguous)", async () => {
    promptUnderTest = input;
    // The prompt is recorded, then another prompt inside the same turn: whose reply is it?
    fakeClaude((t) => [
      append(t, userLine(written())),
      append(t, userLine("another prompt inside the turn")),
    ]);
    const { call, attempts } = await runClassifierCall(input);
    expect(call.exitCode).toBe(1);
    expect(call.diagnostic?.reason).toBe("turn-error");
    // The prompt may have run: no second attempt, and the supervisor did not replay it either.
    expect(attempts).toBe(1);
    expect(spawns).toBe(1);
  });
});

describe("#570 failed-turn latency and cancellation", () => {
  it("an API-error-only transcript returns exit 1 straight away", async () => {
    fakeClaude((t) => [append(t, userLine(PROMPT)), append(t, apiError)]);
    const started = Date.now();
    const result = await runOnceOnPty({ ...request, timeoutMs: 10_000 });
    expect(result.exitCode).toBe(1);
    expect(result.text).toBe("");
    expect(Date.now() - started).toBeLessThan(2500);
    expect(logged()).toContain("api-error");
  });

  it("an exhausted deadline is a timeout (124), and the call does not wait past it", async () => {
    fakeClaude((t) => [append(t, userLine(PROMPT))]);
    const started = Date.now();
    const result = await runOnceOnPty({ ...request, timeoutMs: 400 });
    expect(result.exitCode).toBe(124);
    expect(result.text).toBe("");
    // 15 s plus a 1 s floor with the old second wait; the observer's deadline is the only one.
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("no reply with deadline to spare is a failure (1), not a timeout", async () => {
    fakeClaude(() => []);
    const result = await runOnceOnPty({ ...request, timeoutMs: 10_000 });
    expect(result.exitCode).toBe(1);
  });

  it("an abort during the turn is exit 124, reason aborted", async () => {
    fakeClaude((t) => [append(t, userLine(PROMPT))]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const result = await runOnceOnPty({ ...request, timeoutMs: 10_000, signal: controller.signal });
    expect(result.exitCode).toBe(124);
    expect(result.text).toBe("");
    expect(result.diagnostic?.reason).toBe("aborted");
  });
});
