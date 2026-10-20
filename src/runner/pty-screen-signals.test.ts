import { describe, expect, it } from "bun:test";
import {
  actionWord,
  argvShape,
  errorWord,
  plainWord,
  screenLogLine,
  screenSignals,
  withoutDirNames,
} from "./pty-screen-signals.js";

/**
 * #570 r14d (M1): the repo is public, so a CI log line about the child's screen may carry flags,
 * fixed reason names and counts, and nothing else. A word-by-word redaction of terminal text
 * cannot be complete; these fix the shape of what is allowed out instead.
 */

const LOG_LINE =
  /^\[isolation-spike\] screen-signals [\w-]+: \{"lines":\d+,"permissionPrompt":(true|false),"errorBanner":(true|false),"spinner":(true|false),"blocked":"(none|login-required|onboarding|trust-dialog)","ready":(true|false)\}; source=(live|exit-tail)$/;

describe("screenSignals", () => {
  const SECRET = "hunter2-Zq81vLmN4";
  const hostile = [
    `password is ${SECRET}`,
    `Do you trust the files in this folder?\n  /tmp/claudeclaw-oneshot-cfg-AbC123/.claude.json\nalice@example.com ${SECRET}`,
    `error: sk-ant-oat01-${SECRET}\n\n\nesc to interrupt ✻ ${SECRET}\ntab to cycle`,
    `${SECRET}\r\n`.repeat(100),
  ];

  it("lets nothing of the screen into the log line, whatever the screen holds", () => {
    for (const screen of hostile) {
      const line = screenLogLine("probe-1", "live", screenSignals(screen));
      // Went red (the secret in the line) with a sample of the text added to the signals.
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain("example.com");
      expect(line).not.toContain("claudeclaw-oneshot");
      // Went red (no match) with any field beyond the six fixed ones, or a free-text value in them.
      expect(line).toMatch(LOG_LINE);
    }
  });

  it("still says what the screen is: flags, a blocked screen by name, the footer, a line count", () => {
    const signals = screenSignals(
      `Do you trust the files in this folder?\n1. Yes\n\n   \nerror: x\nesc to interrupt\ntab to cycle`,
    );
    // Went red (blocked "none") with the blocked-screen lookup removed.
    expect(signals).toEqual({
      lines: 5,
      permissionPrompt: true,
      errorBanner: true,
      spinner: true,
      blocked: "trust-dialog",
      ready: true,
    });
  });

  it("reports an empty screen as zero lines and nothing blocked", () => {
    expect(screenSignals("  \n\r\n")).toEqual({
      lines: 0,
      permissionPrompt: false,
      errorBanner: false,
      spinner: false,
      blocked: "none",
      ready: false,
    });
  });

  it("counts at most the last 40 lines", () => {
    expect(screenSignals("x\n".repeat(100)).lines).toBe(40);
  });
});

describe("the other words the harness prints from the child's side", () => {
  it("plainWord keeps a short plain word and replaces anything else", () => {
    expect(plainWord("assistant")).toBe("assistant");
    expect(plainWord("end_turn")).toBe("end_turn");
    // Went red (the sentence passed through) with the pattern loosened to allow spaces.
    expect(plainWord("my password is hunter2")).toBe("other");
    expect(plainWord("a".repeat(33))).toBe("other");
    expect(plainWord("")).toBe("other");
  });

  it("actionWord names the one known action and hides the rest", () => {
    expect(actionWord("hire")).toBe("hire");
    expect(actionWord("hunter2")).toBe("other");
    expect(actionWord(undefined)).toBe("none");
  });

  it("errorWord is a code or a class name, never the message", () => {
    expect(errorWord(Object.assign(new Error("secret at /tmp/x"), { code: "ENOENT" }))).toBe(
      "ENOENT",
    );
    expect(errorWord(new TypeError("secret at /tmp/x"))).toBe("TypeError");
    // Went red (the message in the word) with String(error) printed.
    expect(errorWord(Object.assign(new Error("m"), { code: "bad code: hunter2/" }))).toBe(
      "badcodehunter2",
    );
    expect(errorWord(undefined)).toBe("error");
  });

  it("argvShape replaces prompt text with its length and leaves the flags", () => {
    expect(
      argvShape(["--model", "haiku", "--system-prompt", "Return hunter2", "--tools", ""]),
    ).toEqual(["--model", "haiku", "--system-prompt", "<14 chars>", "--tools", ""]);
    expect(argvShape(["--append-system-prompt", "abc"])).toEqual([
      "--append-system-prompt",
      "<3 chars>",
    ]);
  });

  it("withoutDirNames drops the random name of a throwaway directory", () => {
    const line = "[oneshot] 2 unreadable process(es) of claudeclaw-oneshot-cfg-AbC123 still alive";
    expect(withoutDirNames(line)).toBe("[oneshot] 2 unreadable process(es) of <dir> still alive");
  });
});
