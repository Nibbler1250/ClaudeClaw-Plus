/**
 * Guard for the PTY turn-evidence rule (#562 round 2; `.planning/pty-migration/SPEC.md`,
 * CLAUDE.md "PTY turn evidence"):
 *
 *   The screen is never evidence that a prompt was accepted, that a turn finished, or of
 *   what the answer was. Only the session transcript is. The screen may be used for
 *   readiness, dialogs and liveness, and only to stop or fail a turn, never to mark it
 *   successful.
 *
 * The modules that DECIDE a turn's outcome or BUILD its returned answer must therefore not
 * reach the screen parser's completion/answer API. That API is the sentinel round trip and
 * the screen-to-text extractors in `pty-output-parser.ts`. This test reads their source and
 * fails when one imports, re-exports or requires any of it.
 *
 * It scans text rather than the module graph on purpose: a lint rule can be switched off, a
 * barrel can hide a re-export, and an import is exactly the thing a later "quick fix" adds.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Modules that decide whether a turn succeeded or build the answer it returns. */
const SUCCESS_DECIDING_MODULES = [
  "src/runner/pty-process.ts",
  "src/runner/pty-transcript.ts",
  "src/runner/pty-supervisor.ts",
  "src/runner/live-session-actions.ts",
] as const;

/**
 * The parser's completion/answer API: the pieces that turn screen bytes into "the prompt was
 * taken", "the turn is over" or "this is the answer".
 *
 *   createParser / startTurn / feed / tick / markSentinelWritten / resetTurn   the state machine
 *   buildSentinel / encodeSentinel                                              the sentinel echo
 *   extractResponseText / decodeTurn / normaliseNewlines                        screen → answer text
 *   Parser / ParserEvent / ParserState                                          its state types
 *
 * NOT forbidden: `stripAnsi` (boot-screen and dialog matching in `_waitForReadySettle`, a
 * readiness use) and `DEFAULT_QUIET_WINDOW_MS`.
 */
export const FORBIDDEN_PARSER_SYMBOLS: ReadonlySet<string> = new Set([
  "createParser",
  "startTurn",
  "feed",
  "tick",
  "markSentinelWritten",
  "resetTurn",
  "buildSentinel",
  "encodeSentinel",
  "extractResponseText",
  "decodeTurn",
  "normaliseNewlines",
  "Parser",
  "ParserEvent",
  "ParserState",
]);

const PARSER_SPECIFIER = /(^|\/)pty-output-parser(\.[cm]?[jt]s)?$/;

interface Violation {
  line: number;
  what: string;
}

/** Every import/export-from/require/dynamic-import binding in `src`, with its specifier. */
function bindingsOf(
  src: string,
): Array<{ specifier: string; names: string[]; namespace: boolean; line: number }> {
  const out: Array<{ specifier: string; names: string[]; namespace: boolean; line: number }> = [];
  const lineAt = (idx: number): number => src.slice(0, idx).split("\n").length;

  const statement = /\b(?:import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["']/g;
  for (const m of src.matchAll(statement)) {
    const clause = m[2] ?? "";
    const namespace = /^\*\s*(as\s+\w+)?$/.test(clause.trim()) || /\*\s+as\s+\w+/.test(clause);
    const names: string[] = [];
    const braces = /\{([\s\S]*?)\}/.exec(clause);
    if (braces) {
      for (const part of (braces[1] ?? "").split(",")) {
        const name = part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name) names.push(name);
      }
    }
    const dflt = /^([A-Za-z_$][\w$]*)\s*(,|$)/.exec(clause.trim());
    if (dflt?.[1] && dflt[1] !== "type") names.push(dflt[1]);
    out.push({ specifier: m[3] ?? "", names, namespace, line: lineAt(m.index ?? 0) });
  }
  const dynamic = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of src.matchAll(dynamic)) {
    out.push({ specifier: m[1] ?? "", names: [], namespace: true, line: lineAt(m.index ?? 0) });
  }
  return out;
}

/** What in `src` reaches the parser's completion/answer API (empty = clean). */
export function parserViolations(src: string): Violation[] {
  const found: Violation[] = [];
  for (const b of bindingsOf(src)) {
    const fromParser = PARSER_SPECIFIER.test(b.specifier);
    if (fromParser && b.namespace) {
      found.push({
        line: b.line,
        what: `namespace or dynamic import of the parser (${b.specifier})`,
      });
    }
    for (const name of b.names) {
      if (FORBIDDEN_PARSER_SYMBOLS.has(name)) {
        // From the parser directly, or via a barrel that re-exports it: either way the name
        // is the parser's. These names are not used for anything else in these modules.
        found.push({ line: b.line, what: `imports ${name} from ${b.specifier}` });
      } else if (fromParser && name !== "stripAnsi" && name !== "DEFAULT_QUIET_WINDOW_MS") {
        found.push({
          line: b.line,
          what: `imports ${name} from the parser, which is not an allowed readiness helper`,
        });
      }
    }
  }
  return found;
}

const root = join(import.meta.dir, "..", "..");

describe("PTY turn evidence: the modules that decide success do not read the screen parser's completion API", () => {
  for (const rel of SUCCESS_DECIDING_MODULES) {
    test(`${rel} imports nothing from the parser's completion/answer API`, () => {
      const src = readFileSync(join(root, rel), "utf8");
      // Fault: add `import { feed } from "./pty-output-parser"` (or any forbidden name, from
      // any module) to this file and this list is no longer empty.
      expect(parserViolations(src)).toEqual([]);
    });
  }

  test("the guard names the modules that exist (a renamed file must not silently drop out)", () => {
    for (const rel of SUCCESS_DECIDING_MODULES) {
      expect(() => readFileSync(join(root, rel), "utf8")).not.toThrow();
    }
  });
});

describe("the guard itself can fail", () => {
  const bad: Array<[string, string]> = [
    ["a named import from the parser", `import { feed, stripAnsi } from "./pty-output-parser";`],
    ["an aliased import", `import { decodeTurn as d } from "./pty-output-parser";`],
    ["a type-only import of parser state", `import type { Parser } from "./pty-output-parser";`],
    ["a namespace import", `import * as P from "./pty-output-parser";`],
    ["a dynamic import", `const p = await import("./pty-output-parser");`],
    ["a require", `const p = require("./pty-output-parser");`],
    ["a re-export", `export { extractResponseText } from "./pty-output-parser";`],
    ["the same name through a barrel", `import { tick } from "./index";`],
    [
      "a multi-line import",
      `import {\n  stripAnsi,\n  extractResponseText,\n} from "./pty-output-parser";`,
    ],
    [
      "a parser helper that is not on the readiness allow-list",
      `import { expandCursorForwardToSpaces } from "./pty-output-parser";`,
    ],
  ];
  for (const [label, src] of bad) {
    test(`flags ${label}`, () => {
      expect(parserViolations(src).length).toBeGreaterThan(0);
    });
  }

  test("allows the readiness helper and unrelated code", () => {
    expect(
      parserViolations(
        `import { stripAnsi } from "./pty-output-parser";\nimport { join } from "node:path";\nconst x = stripAnsi("a");`,
      ),
    ).toEqual([]);
  });
});
