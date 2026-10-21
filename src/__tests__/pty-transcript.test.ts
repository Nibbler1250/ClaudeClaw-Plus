/**
 * The transcript reader behind every PTY turn (#562 round 2): acceptance, answer and the
 * end of the reply come from the file the CLI writes, never from the screen.
 *
 * Pure: a temp file stands in for the transcript and the tests append to it by hand, in
 * whatever partitions they like. Each assertion names the fault that turns it red.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTranscriptPath, TranscriptTurn } from "../runner/pty-transcript";
import {
  assistantLine,
  enqueueLine,
  systemLine,
  type TempTranscript,
  tempTranscript,
  userLine,
} from "./fixtures/fake-claude-tui";

const made: TempTranscript[] = [];
function tx(): TempTranscript {
  const t = tempTranscript();
  made.push(t);
  return t;
}
afterEach(() => {
  while (made.length) made.pop()?.cleanup();
});

function turn(t: TempTranscript, written = "R17x please", replCommand = false): TranscriptTurn {
  const turn = new TranscriptTurn({ path: t.path, written, replCommand });
  turn.mark();
  return turn;
}
const nl = (...lines: string[]): string => `${lines.join("\n")}\n`;

describe("TranscriptTurn — acceptance", () => {
  test("a user entry for this prompt appended after the mark is acceptance", () => {
    const t = tx();
    const turn_ = turn(t);
    expect(turn_.poll().accepted).toBe(false);
    appendFileSync(t.path, nl(userLine("R17x please")));
    expect(turn_.poll().accepted).toBe(true);
  });

  test("an EARLIER identical prompt does not count: only bytes after the mark are read", () => {
    // Worst case exceeds the bound: the old entry is byte-identical to the new prompt.
    // Fault: mark() at offset 0 instead of the size and this goes true.
    const t = tx();
    writeFileSync(t.path, nl(userLine("R17x please"), assistantLine("OLD")));
    const turn_ = turn(t);
    const s = turn_.poll();
    expect(s.accepted).toBe(false);
    expect(s.answer).toBe("");
  });

  test("a queue-operation enqueue for this prompt is acceptance too", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(enqueueLine("R17x please")));
    expect(turn_.poll().accepted).toBe(true);
  });

  test("a different prompt is counted as foreign and is not acceptance", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(userLine("something else entirely")));
    const s = turn_.poll();
    expect(s.accepted).toBe(false);
    expect(s.foreignUserEntries).toBe(1);
  });

  test("tool results and sub-agent lines are not this turn's prompt", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "x", content: "R17x please" }],
          },
        }),
        JSON.stringify({
          type: "user",
          isSidechain: true,
          message: { role: "user", content: "R17x please" },
        }),
      ),
    );
    expect(turn_.poll().accepted).toBe(false);
  });

  test("the prompt may arrive wrapped (a paste wrapper, a prefix): containment, whitespace-insensitive", () => {
    const t = tx();
    const turn_ = turn(t, "R17x   please");
    appendFileSync(t.path, nl(userLine("[clock 12:00]\nR17x please\n")));
    expect(turn_.poll().accepted).toBe(true);
  });

  test("an empty prompt matches nothing (it would match every entry)", () => {
    const t = tx();
    const turn_ = turn(t, "");
    appendFileSync(t.path, nl(userLine("anything")));
    expect(turn_.poll().accepted).toBe(false);
  });
});

describe("TranscriptTurn — answer and end of reply", () => {
  test("the answer is the assistant text after the matched user entry, and the terminal stop ends it", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(userLine("R17x please"), assistantLine("NEW-ANSWER")));
    const s = turn_.poll();
    expect(s.answer).toBe("NEW-ANSWER");
    expect(s.ended).toBe(true);
  });

  test("an assistant entry BEFORE the user entry is not this turn's answer", () => {
    // Fault: ingest assistant lines regardless of userMatched and OLD is returned.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(assistantLine("OLD-ANSWER"), userLine("R17x please")));
    const s = turn_.poll();
    expect(s.answer).toBe("");
    expect(s.ended).toBe(false);
  });

  test("a tool_use stop does not end the turn; the final end_turn message does and is the answer", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        assistantLine("", {
          id: "m1",
          stop: "tool_use",
          blocks: [
            { type: "text", text: "Let me look." },
            { type: "tool_use", name: "Read", input: { file_path: "/a" } },
          ],
        }),
      ),
    );
    let s = turn_.poll();
    expect(s.ended).toBe(false);
    expect(s.toolLines).toEqual(['● Read({"file_path":"/a"})']);
    appendFileSync(t.path, nl(assistantLine("FINAL", { id: "m2", stop: "end_turn" })));
    s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.answer).toBe("FINAL");
  });

  test("blocks of ONE message arriving over separate polls are joined, in full", () => {
    // The answer is split across appends; none of it may be dropped (round 2, finding 3).
    // Fault: replace instead of append for a repeated message id and only the tail is left.
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(userLine("R17x please"), assistantLine("PART-ONE ", { id: "m1", stop: null })),
    );
    expect(turn_.poll().answer).toBe("PART-ONE ");
    appendFileSync(t.path, nl(assistantLine("PART-TWO ", { id: "m1", stop: null })));
    appendFileSync(t.path, nl(assistantLine("PART-THREE", { id: "m1", stop: "end_turn" })));
    const s = turn_.poll();
    expect(s.answer).toBe("PART-ONE PART-TWO PART-THREE");
    expect(s.ended).toBe(true);
  });

  test("turn_duration ends a turn whose last assistant line carried no stop reason", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(t.path, nl(userLine("R17x please"), assistantLine("A", { stop: null })));
    expect(turn_.poll().ended).toBe(false);
    appendFileSync(t.path, nl(systemLine("turn_duration")));
    expect(turn_.poll().ended).toBe(true);
  });

  test("a CLI-written API error line ends the turn instead of hanging it", () => {
    const t = tx();
    const turn_ = turn(t);
    appendFileSync(
      t.path,
      nl(
        userLine("R17x please"),
        JSON.stringify({
          type: "assistant",
          isApiErrorMessage: true,
          message: {
            id: "e",
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "API Error: 529" }],
          },
        }),
      ),
    );
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.answer).toBe("API Error: 529");
  });
});

describe("TranscriptTurn — delivery shape never changes the verdict", () => {
  const FULL = nl(
    userLine("R17x please"),
    assistantLine("PART-A ", { id: "m1", stop: null }),
    assistantLine("PART-B", { id: "m1", stop: "end_turn" }),
  );
  // Cut points are bytes, so every one of these tears a JSON line somewhere.
  const cuts = (n: number): number[] =>
    Array.from({ length: n }, (_, i) => Math.floor(((i + 1) * FULL.length) / (n + 1)));
  const partitions: Array<[string, number[]]> = [
    ["one write", []],
    ["two halves", cuts(1)],
    ["five parts", cuts(4)],
    ["a cut inside every line", [10, 30, FULL.indexOf("\n") + 5, FULL.length - 7]],
    ["one byte at a time at the end", Array.from({ length: 20 }, (_, i) => FULL.length - 20 + i)],
  ];
  for (const [name, points] of partitions) {
    test(`${name}: same verdict and answer as one write`, () => {
      // Fault: drop the carry of a torn trailing line and the second half of it is lost.
      const t = tx();
      const turn_ = turn(t);
      let from = 0;
      for (const at of [...points, FULL.length]) {
        appendFileSync(t.path, FULL.slice(from, at));
        turn_.poll();
        from = at;
      }
      const s = turn_.poll();
      expect(s.accepted).toBe(true);
      expect(s.answer).toBe("PART-A PART-B");
      expect(s.ended).toBe(true);
    });
  }

  test("a transcript that shrinks (replaced) is re-read from the top", () => {
    const t = tx();
    writeFileSync(t.path, `${"x".repeat(500)}\n`);
    const turn_ = turn(t);
    writeFileSync(t.path, nl(userLine("R17x please"), assistantLine("AFTER-REPLACE")));
    expect(turn_.poll().answer).toBe("AFTER-REPLACE");
  });
});

describe("TranscriptTurn — /compact", () => {
  const cmd = "<command-name>/compact</command-name>\n<command-message>compact</command-message>";
  test("accepted by the command entry, ended by compact_boundary", () => {
    const t = tx();
    const turn_ = turn(t, "/compact", true);
    appendFileSync(t.path, nl(userLine(cmd)));
    let s = turn_.poll();
    expect(s.accepted).toBe(true);
    expect(s.ended).toBe(false);
    appendFileSync(t.path, nl(systemLine("compact_boundary", "Conversation compacted")));
    s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.answer).toBe("Conversation compacted");
  });

  test("a failed compact ends on its local_command error, carrying the CLI's text", () => {
    const t = tx();
    const turn_ = turn(t, "/compact", true);
    appendFileSync(
      t.path,
      nl(
        userLine(cmd),
        systemLine(
          "local_command",
          "<local-command-stderr>Error: Not enough messages to compact.</local-command-stderr>",
        ),
      ),
    );
    const s = turn_.poll();
    expect(s.ended).toBe(true);
    expect(s.answer).toBe("Error: Not enough messages to compact.");
  });

  test("another command's entry is not this /compact", () => {
    const t = tx();
    const turn_ = turn(t, "/compact", true);
    appendFileSync(t.path, nl(userLine("<command-name>/clear</command-name>")));
    expect(turn_.poll().accepted).toBe(false);
  });
});

describe("resolveTranscriptPath", () => {
  const env = { CLAUDE_CONFIG_DIR: "/cfg" };
  test("config dir, projects, encoded cwd, session id", () => {
    expect(resolveTranscriptPath({ cwd: "/definitely/not/there", sessionId: "abc", env })).toBe(
      "/cfg/projects/-definitely-not-there/abc.jsonl",
    );
  });
  test("the cwd is realpath'd: the CLI encodes the physical directory", () => {
    const real = join(tmpdir(), `pty-real-${process.pid}`);
    const link = `${real}-link`;
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    const physical = resolveTranscriptPath({ cwd: link, sessionId: "abc", env }) as string;
    const direct = resolveTranscriptPath({ cwd: real, sessionId: "abc", env }) as string;
    expect(physical).toBe(direct);
  });
  test("no session id, or an untrusted one-shot: no transcript", () => {
    expect(resolveTranscriptPath({ cwd: "/a", sessionId: "", env })).toBeNull();
    expect(resolveTranscriptPath({ cwd: "/a", sessionId: "abc", env, untrusted: true })).toBeNull();
  });
});
