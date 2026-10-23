/**
 * #581 cp4: the isolated transcript source of `TranscriptTurn`.
 *
 * An untrusted one-shot has a throwaway config root and no session id, so the CLI names its
 * session file itself. The observer discovers that file in the root's project directory, binds
 * it by inode, and attributes only the records appended after the send that carry the exact
 * bytes written. These tests drive it on real files, with no PTY: the process-level behaviour
 * (the screen disagreeing with the transcript, abort, deadline) is in pty-isolated-turn.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { neutralizeFileMentions } from "../runner/pty-prompt-sanitizer";
import {
  MULTIPLE_FILES_TEXT,
  resolveIsolatedProjectDir,
  TranscriptReplacedError,
  TranscriptTurn,
} from "../runner/pty-transcript";
import { assistantLine, systemLine, userLine } from "./fixtures/fake-claude-tui";

const PROMPT = "classify this message";

let root: string;
let project: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pty-isolated-"));
  project = join(root, "projects", "-enc-cwd");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const observe = (written = PROMPT) => new TranscriptTurn({ isolatedProjectDir: project, written });
const lines = (...entries: string[]): string => `${entries.join("\n")}\n`;
const complete = (answer = "the answer", prompt = PROMPT): string =>
  lines(userLine(prompt), assistantLine(answer), systemLine("turn_duration"));
const put = (name: string, body: string): string => {
  mkdirSync(project, { recursive: true });
  const path = join(project, name);
  writeFileSync(path, body);
  return path;
};

describe("discovery: before and after the prompt was written", () => {
  test("a session file the CLI creates after the send is found and read from its first byte", () => {
    const turn = observe();
    turn.mark(); // no project directory yet: the CLI creates it
    put("s1.jsonl", complete("created after"));
    // Went red (not accepted) with a discovered file's start offset taken from the file as it is
    // at the first poll, after the prompt was written, instead of from the snapshot.
    const state = turn.poll();
    expect(state.accepted).toBe(true);
    expect(state.ended).toBe(true);
    expect(state.failure).toBeNull();
    expect(state.answer).toBe("created after");
  });

  test("records the CLI appended between the send and the first poll are read, not skipped", () => {
    const path = put("s1.jsonl", lines(JSON.stringify({ type: "summary", summary: "old" })));
    const turn = observe();
    turn.mark();
    // The prompt was written, the CLI answered, and only now is the directory looked at.
    appendFileSync(path, complete("appended before first poll"));
    const state = turn.poll();
    expect(state.ended).toBe(true);
    expect(state.answer).toBe("appended before first poll");
  });

  test("a stale reply to the same prompt, already in the file at the send, is never this turn's", () => {
    const stale = put("s1.jsonl", complete("STALE answer"));
    const turn = observe();
    turn.mark();
    expect(turn.poll()).toMatchObject({ accepted: false, ended: false, answer: "" });
    appendFileSync(stale, complete("fresh answer"));
    const state = turn.poll();
    expect(state.ended).toBe(true);
    expect(state.answer).toBe("fresh answer");
  });

  test("the read offset is the snapshot's: the start never moves once the prompt is written", () => {
    const before = lines(JSON.stringify({ type: "summary", summary: "x" }));
    const path = put("s1.jsonl", before);
    const turn = observe();
    turn.mark();
    appendFileSync(path, complete("a"));
    turn.poll();
    expect(turn.readOffset()).toBe(Buffer.byteLength(before) + Buffer.byteLength(complete("a")));
  });
});

describe("which file is this turn's", () => {
  test("a file with other prompts only is not this turn's, and does not stop the real one binding", () => {
    const other = put("other.jsonl", lines(userLine("a different prompt")));
    const turn = observe();
    turn.mark();
    // Only what is appended after the send is read: the first line was there at the mark.
    appendFileSync(other, lines(userLine("and another")));
    expect(turn.poll()).toMatchObject({ accepted: false, foreignUserEntries: 1 });
    put("mine.jsonl", complete("mine"));
    const state = turn.poll();
    expect(state.accepted).toBe(true);
    expect(state.answer).toBe("mine");
  });

  test("two files that both record the prompt fail the turn as ambiguous", () => {
    const turn = observe();
    turn.mark();
    put("a.jsonl", complete("from a"));
    put("b.jsonl", complete("from b"));
    const state = turn.poll();
    expect(state.ended).toBe(true);
    expect(state.answer).toBe("");
    expect(state.failure).toEqual({ kind: "ambiguous", text: MULTIPLE_FILES_TEXT });
  });

  test("a second file that records the prompt after the first was bound fails the turn", () => {
    const turn = observe();
    turn.mark();
    put("a.jsonl", lines(userLine(PROMPT)));
    expect(turn.poll()).toMatchObject({ accepted: true, ended: false, failure: null });
    put("b.jsonl", lines(userLine(PROMPT)));
    expect(turn.poll().failure).toEqual({ kind: "ambiguous", text: MULTIPLE_FILES_TEXT });
  });

  test("symlinks and subdirectories are not candidates", () => {
    const outside = join(root, "operator-session.jsonl");
    writeFileSync(outside, complete("OPERATOR session answer"));
    const turn = observe();
    turn.mark();
    mkdirSync(project, { recursive: true });
    symlinkSync(outside, join(project, "linked.jsonl"));
    mkdirSync(join(project, "sub"));
    writeFileSync(join(project, "sub", "nested.jsonl"), complete("nested answer"));
    expect(turn.poll()).toMatchObject({ accepted: false, ended: false, answer: "" });
  });

  test("a directory holding more transcript files than one call can write fails closed", () => {
    const turn = observe();
    turn.mark();
    for (let i = 0; i < 65; i++) put(`f${i}.jsonl`, lines(userLine(`p${i}`)));
    expect(() => turn.poll()).toThrow(TranscriptReplacedError);
  });
});

describe("the exact bytes that were written", () => {
  const MENTION = "mail a@b.co about it";

  test("the neutralised user line matches", () => {
    const written = neutralizeFileMentions(MENTION);
    expect(written).not.toBe(MENTION);
    const turn = observe(written);
    turn.mark();
    put("s.jsonl", complete("sent", written));
    expect(turn.poll()).toMatchObject({ accepted: true, ended: true, answer: "sent" });
  });

  test("the pre-neutralisation prompt is a different prompt and is not accepted", () => {
    const turn = observe(neutralizeFileMentions(MENTION));
    turn.mark();
    put("s.jsonl", complete("sent", MENTION));
    expect(turn.poll()).toMatchObject({ accepted: false, ended: false, foreignUserEntries: 1 });
  });
});

describe("the reply", () => {
  test("blocks of one message split over records and polls join into the answer", () => {
    const turn = observe();
    turn.mark();
    const path = put(
      "s.jsonl",
      lines(
        userLine(PROMPT),
        assistantLine("", { id: "m1", stop: null, blocks: [{ type: "thinking", thinking: "…" }] }),
        assistantLine("first ", { id: "m1", stop: null }),
      ),
    );
    expect(turn.poll()).toMatchObject({ accepted: true, ended: false, answer: "first " });
    // The last block arrives torn across two reads.
    const last = assistantLine("second", { id: "m1" });
    appendFileSync(path, last.slice(0, 20));
    expect(turn.poll().answer).toBe("first ");
    appendFileSync(path, `${last.slice(20)}\n${systemLine("turn_duration")}\n`);
    expect(turn.poll()).toMatchObject({ ended: true, answer: "first second", failure: null });
  });

  test("a synthetic placeholder is neither text nor an end", () => {
    const turn = observe();
    turn.mark();
    const synthetic = JSON.stringify({
      type: "assistant",
      message: {
        id: "syn",
        model: "<synthetic>",
        content: [{ type: "text", text: "No response requested." }],
        stop_reason: "stop_sequence",
      },
    });
    put(
      "s.jsonl",
      lines(
        userLine(PROMPT),
        synthetic,
        assistantLine("real", { id: "m2" }),
        systemLine("turn_duration"),
      ),
    );
    expect(turn.poll()).toMatchObject({ ended: true, answer: "real" });
  });

  test("a final message with no boundary after it is not an end", () => {
    const turn = observe();
    turn.mark();
    put("s.jsonl", lines(userLine(PROMPT), assistantLine("complete-looking")));
    const state = turn.poll();
    expect(state.ended).toBe(false);
    expect(state.finalSeen).toBe(true);
  });

  test("an API error before the boundary fails the turn and leaves no answer", () => {
    const turn = observe();
    turn.mark();
    const apiError = JSON.stringify({
      type: "assistant",
      isApiErrorMessage: true,
      message: {
        id: "e",
        model: "<synthetic>",
        content: [{ type: "text", text: "API Error: 400" }],
      },
    });
    put("s.jsonl", lines(userLine(PROMPT), assistantLine("real"), apiError));
    const state = turn.poll();
    expect(state.failure).toEqual({ kind: "api-error", text: "API Error: 400" });
    expect(state.answer).toBe("");
  });
});

describe("fail closed", () => {
  test("a bound file that is replaced by a different file fails the turn", () => {
    const turn = observe();
    turn.mark();
    const path = put("s.jsonl", lines(userLine(PROMPT)));
    expect(turn.poll().accepted).toBe(true);
    renameSync(path, join(project, "moved.jsonl.bak"));
    put("s.jsonl", complete("from the replacement"));
    expect(() => turn.poll()).toThrow(/replaced by a different file/);
  });

  test("a bound file that is cut short fails the turn", () => {
    const turn = observe();
    turn.mark();
    const path = put("s.jsonl", lines(userLine(PROMPT), assistantLine("part", { stop: null })));
    turn.poll();
    writeFileSync(path, lines(userLine(PROMPT)));
    expect(() => turn.poll()).toThrow(/cut short/);
  });

  test("a bound file that is removed fails the turn", () => {
    const turn = observe();
    turn.mark();
    const path = put("s.jsonl", lines(userLine(PROMPT)));
    turn.poll();
    rmSync(path);
    expect(() => turn.poll()).toThrow(/was removed/);
  });

  test("a file that existed at the send and was replaced fails the turn", () => {
    const path = put("s.jsonl", lines(JSON.stringify({ type: "summary" })));
    const turn = observe();
    turn.mark();
    renameSync(path, join(project, "old.jsonl.bak"));
    put("s.jsonl", complete("from the replacement"));
    expect(() => turn.poll()).toThrow(/replaced by a different file/);
  });

  test.skipIf(process.getuid?.() === 0)(
    "an unreadable file fails the turn instead of being skipped",
    () => {
      const turn = observe();
      turn.mark();
      const path = put("s.jsonl", complete("cannot be read"));
      chmodSync(path, 0o000);
      try {
        expect(() => turn.poll()).toThrow(/could not be read/);
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  test("a project directory that cannot be listed fails at mark(), before anything is sent", () => {
    mkdirSync(root, { recursive: true });
    const notADirectory = join(root, "file-where-the-directory-should-be");
    writeFileSync(notADirectory, "x");
    const turn = new TranscriptTurn({ isolatedProjectDir: notADirectory, written: PROMPT });
    expect(() => turn.mark()).toThrow(TranscriptReplacedError);
  });

  test("exactly one source is required", () => {
    expect(() => new TranscriptTurn({ written: PROMPT })).toThrow(/exactly one/);
    expect(
      () =>
        new TranscriptTurn({
          path: join(root, "x.jsonl"),
          isolatedProjectDir: project,
          written: PROMPT,
        }),
    ).toThrow(/exactly one/);
  });
});

describe("resolveIsolatedProjectDir: only the call's own root", () => {
  const cwd = (): string => {
    const dir = join(root, "cwd");
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  test("is the physical project directory under the throwaway root", () => {
    const throwaway = join(root, "throwaway");
    mkdirSync(throwaway);
    const dir = resolveIsolatedProjectDir({ cwd: cwd(), env: { CLAUDE_CONFIG_DIR: throwaway } });
    expect(dir?.startsWith(join(throwaway, "projects") + "/")).toBe(true);
  });

  test("there is none without a root, and it never falls back to the home config", () => {
    expect(resolveIsolatedProjectDir({ cwd: cwd(), env: { HOME: root } })).toBeNull();
    expect(resolveIsolatedProjectDir({ cwd: cwd(), env: { CLAUDE_CONFIG_DIR: "" } })).toBeNull();
  });

  test("a relative root is refused", () => {
    expect(
      resolveIsolatedProjectDir({ cwd: cwd(), env: { CLAUDE_CONFIG_DIR: "relative/root" } }),
    ).toBeNull();
  });

  test("the operator's own roots are refused", () => {
    expect(
      resolveIsolatedProjectDir({
        cwd: cwd(),
        env: { CLAUDE_CONFIG_DIR: join(homedir(), ".claude") },
      }),
    ).toBeNull();
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(root, "operator-config");
    try {
      expect(
        resolveIsolatedProjectDir({
          cwd: cwd(),
          env: { CLAUDE_CONFIG_DIR: join(root, "operator-config") },
        }),
      ).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
});
