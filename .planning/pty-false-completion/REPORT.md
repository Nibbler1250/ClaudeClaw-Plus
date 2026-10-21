# #562: a PTY turn reported "done" when the prompt never reached the model

Branch `feat/550-pty-default`, PR #562. Pre-fix head `fa2c625d`. Soak evidence:
Nibbler, 48 h, Linux, CLI 2.1.296, default settings (runner 3/49 and cron 6/50 false
completions).

## Summary

The turn was reported done because the parser's "quiet" gate could be opened by a
**repaint of the previous conversation**, with no evidence that this turn had started.
A paste that was never submitted sat in claude's input box, the TUI repainted its old
screen (spinner glyph, `✻ … done 16:36` summary, `✳` title, idle footer), the gate
opened, the sentinel echoed into the input box, and the last `●` block of the repaint
came back as the answer: exit 0, 2-3 s, no transcript entry. Reproduced against the
unpatched code with a fake TUI (below). The fix makes a turn-start edge a precondition
of completion, retries the submit once, fails the turn if it still was not accepted, and
slices the answer from the edge instead of the send.

Not verified against a real claude (see "Real PTY").

## Diagnosis

The brief's H1 talks about a "footer". The detector is not footer-only: it is a
sentinel echo gated by `tick()` (`src/runner/pty-output-parser.ts:399-436` at
`fa2c625d`), and the footer is one of four completion signals.

### H1: done detection matches stale evidence with no "turn began" edge. CONFIRMED

`tick()` fires `quiet` (the cue to write the sentinel) when all of these hold:

| Gate | Line (`fa2c625d`) | Can a repaint of the old screen satisfy it? |
|---|---|---|
| a byte arrived since `startTurn` | `pty-output-parser.ts:409` | yes, any repaint byte |
| a spinner glyph `✻✶✳✢✽✺✷◉` since `startTurn` | `:420`, scan at `:546` | yes: the old turn's `✻ Sautéed for 1s · done` line |
| idle footer, done-summary OR `✳` title in the 2048-byte tail | `:430`, `hasTurnDoneSummary` `:381`, `hasIdleTitle` `:342` | yes: all three belong to the old, finished turn |
| quiet window elapsed | `:433` | yes |

None of them says "this prompt was accepted". `startTurn` empties `footerTail`
(`:211`), which only guards against evidence from BEFORE the send; the repaint arrives
AFTER it. A resumed session redraws its whole screen when a paste lands, which is why
8 of 9 failures were on long-resumed sessions.

Probe (pre-fix code, `/bin/sh` fake TUI that reads the paste line, repaints
`● OLD-ANSWER-R15x` + `✻ Sautéed for 1s · done 16:36` + `shift+tab to cycle`, and never
submits; kernel echo stands in for the input box):

```
RESOLVED after 111 ms clean= true text= "OLD-ANSWER-R15x"
```

Exit 0 (`pty-supervisor.ts:2289-2294` ignores `cleanBoundary`), 111 ms, the old answer as
the result. Same shape as the soak (2-3 s there: 500 ms quiet window plus real latency).

The returned text is the last `●` block of the repaint: `extractResponseText`
(`pty-output-parser.ts:701-747`, `markerRe` `:714`) takes the LAST line-anchored `●` in
the turn buffer, and the slice starts at the send (`pty-process.ts:856`), so the old
screen is inside it.

### H2: the submit key is sent before the TUI consumed the paste. PLAUSIBLE TRIGGER, NOT MEASURED

`runTurn` writes `ESC[200~ prompt ESC[201~ CR` in ONE `write`
(`pty-process.ts:752-753`). If the TUI handles the paste asynchronously the CR can be
dropped or folded into the paste, leaving the text unsubmitted. That is consistent with
"no new user entry in the transcript", and with #559 (the previous instance of this). I
cannot measure it without a real authenticated claude, so H2 is treated as the likely
TRIGGER and H1 as the reason it was REPORTED as done. The fix covers both: a second CR
after `submitConfirmMs` if no turn started, and a loud failure if that fails too.

### H3: resumed sessions corrupt the output offset bookkeeping. REFUTED

`_turnBuf` is reset at `runTurn` (`pty-process.ts:724`) and `turnStartOffset` is set from
`totalBytes` in the same synchronous step (`pty-output-parser.ts:199`);
`_completeTurn`'s slice arithmetic (`pty-process.ts:856-865`) is consistent with that
(and has a regression test for the pre-turn-banner case, `pty-process.test.ts`, "Codex PR
#82 P1"). In the probe above the fake prints the old screen only AFTER it reads the
prompt, so the stale text really arrived after the send: the slice started in the right
place, the repaint was inside it. The long-resumed correlation is explained by H1: a
longer conversation means more old chrome to repaint.

## What I took from ClaudeClaw-Ultra (`3750fbe0`, #500)

- **Principle** (from `docs/standards/driving-the-claude-tui.md` in that repo, which the
  commit amends): the screen is spoofable, so "the prompt was submitted" must come from
  positive evidence, not from the screen being in an idle-looking state. Ultra gets it
  from the transcript's user line. I did not port that tracker: a fresh session has no
  transcript yet, and untrusted one-shots run with `--no-session-persistence`, so the
  transcript cannot be the only proof on this path. The byte-stream edge is available on
  every path. A transcript check remains a possible second line of defence.
- **Footer region anchoring + "busy marker after the footer withdraws idle"**: I looked
  at it and did NOT port it. It fixes a different bug (model text quoting "tab to cycle"
  mid-turn). It would not have stopped this one: the stale footer in a repaint IS in the
  footer region. Plus already judges the footer per line against `esc to interrupt`
  (#369).

## Fix

`src/runner/pty-output-parser.ts`
- New `sawTurnStartEdge` / `turnEdgeOffset`. The edge is what claude paints only while a
  turn runs: a running window title (`◐◑◒◓` or a braille glyph, not the idle `✳`), the busy
  footer `esc to interrupt` (CUF/CHA gaps tolerated), or `Compacting conversation` (what
  the allowed `/compact` paints). All three are captured shapes from #369's tests and the
  `sentinel-turn-sample.bin` fixture, not guesses.
- `tick()` withholds `quiet` until the edge is seen. When it latches, `footerTail` is cut
  to the edge chunk, so completion evidence (summary, footer, `✳` title) must POSTDATE it:
  a repainted summary still in the tail cannot open the gate for a turn that has only just
  started (the #316 hole again).
- The edge is scanned over the chunk plus a 96-byte carry, not the capped 2048-byte tail,
  so a marker split across chunks or at the start of a large repaint chunk is not lost.

`src/runner/pty-process.ts`
- `submitConfirmMs` (default 3000). No edge by then: write one bare CR (harmless on an
  empty input box if the first one WAS accepted). No edge after another window: write
  Ctrl-U (so the NEXT turn's CR cannot submit the orphaned paste) and reject with the new
  `PtyPromptNotAcceptedError`.
- The response is sliced from the chunk holding the edge, not from the send, so a repaint
  that preceded the turn is never the answer. Chunk granularity on purpose: cutting at the
  marker itself could drop the first words of an answer painted ahead of the busy footer
  in one frame.
- `onChunk` / `onToolEvent` stream only after the edge, so a streaming caller never shows
  the old screen as this turn's output.

`src/runner/pty-supervisor.ts`
- `PtyPromptNotAcceptedError` is exit 1 (never 0), is NOT retried (a re-sent prompt could
  land twice) and retires the entry, as a timeout does, so the next call respawns and
  resumes. Same in `sendToLiveSession`.

Cron consequence from the soak: a lost turn is now a failed job (exit 1, "PTY prompt not
accepted"), not a pass on stale scrollback.

## Tests

New `src/__tests__/pty-false-completion.test.ts` (7), parser edge tests (7) in
`pty-output-parser.test.ts`, one test each in `pty-supervisor.test.ts` and
`pty-send-to-live.test.ts`. Fake TUIs are real `/bin/sh` children; no real claude.

| Test | What it pins |
|---|---|
| stale footer + summary, paste never submitted | not done; `PtyPromptNotAcceptedError` |
| paste swallowed once, retry lands | completes with only the new output |
| output isolation | the repainted old `●` answer is not the result |
| resumed session, 30 old turns repainted | not mistaken for completion; not the answer |
| accepted on first CR, turn outlasts `submitConfirmMs` | no retry in the PTY trace |
| never accepted | Ctrl-U (0x15) reaches the TUI before the failure |
| `onChunk` on a turn that never started | old screen not streamed |
| parser: repaint never opens the gate; evidence before the edge does not count; edge shapes; split marker; large chunk; offset; reset | |
| supervisor / live: not-accepted | exit 1, one turn, entry retired |

Existing tests whose fake TUIs never painted running chrome (cat-echo prompts, the
`#460/#469` boot-dialog scripts, parser synthetic feeds, `fixtures/paste-burst-tui.ts`)
were updated to paint it. That is the new contract (a real claude paints it every turn),
not a weakened assertion: none of their assertions changed.

### Fault injection (one site at a time, on a `git archive` copy)

Every injection below went RED with the lines shown (verbatim from the run). Two sites
(F8, F12) did NOT go red on the first pass: my first versions of those two tests could
not fail (one used `read -t`, which dash does not have, so it was vacuous on CI; the
other never observed the Ctrl-U). They were rewritten (PTY trace for the retry, a raw-mode
byte read for Ctrl-U) and re-injected; the lines below are from the rewritten tests.

**F1: drop the turn-start gate from `tick` (`pty-output-parser.ts`)**
```
(fail) #562 — a turn completes only on evidence the prompt was accepted > stale footer + summary on screen, paste never submitted: the turn is NOT done
(fail) #562 — a turn completes only on evidence the prompt was accepted > paste swallowed once, the submit retry lands: completes with only the new output
(fail) #562 — a turn completes only on evidence the prompt was accepted > output isolation: the previous turn's answer, repainted before this turn starts, is not the result
(fail) #562 — a turn completes only on evidence the prompt was accepted > resumed session: a repaint of thirty old turns is neither the answer nor mistaken for completion
(fail) pty-output-parser — turn-start edge (#562) > a repaint of the old conversation (spinner + summary + ✳ title + footer) never opens the gate
```

**F2: delete the submit-retry `write("\r")` (`pty-process.ts`)**
```
(fail) #562 — a turn completes only on evidence the prompt was accepted > paste swallowed once, the submit retry lands: completes with only the new output
```

**F3: slice the response from the send instead of the edge (`pty-process.ts` `_completeTurn`)**
```
(fail) #562 — a turn completes only on evidence the prompt was accepted > output isolation: the previous turn's answer, repainted before this turn starts, is not the result
(fail) #562 — a turn completes only on evidence the prompt was accepted > resumed session: a repaint of thirty old turns is neither the answer nor mistaken for completion
```

**F4: keep pre-edge bytes in `footerTail` when the edge latches (`pty-output-parser.ts`)**
```
(fail) pty-output-parser — turn-start edge (#562) > completion evidence painted BEFORE the edge does not count; evidence after it does
```

**F5: stream `onChunk` before the edge (`pty-process.ts`)**
```
(fail) #562 — a turn completes only on evidence the prompt was accepted > onChunk is not fed the stale repaint of a turn that never started
```

**F6: supervisor treats `PtyPromptNotAcceptedError` as retryable (`runTurnWithRetries`)**
```
(fail) pty-supervisor retry and backoff > #562: a prompt claude never accepted is an error (exit 1, never 0), runs once, and retires the entry
```

**F7: `sendToLiveSession` does not retire the entry on not-accepted**
```
(fail) sendToLiveSession > #562: a prompt claude never accepted reports failed (not sent) and retires the entry
```

**F8: the confirm timer ignores the edge and retries anyway (`pty-process.ts`)**
```
(fail) #562 — a turn completes only on evidence the prompt was accepted > a prompt accepted on the first CR is not re-submitted, even when the turn outlasts submitConfirmMs
```

**F9: scan the chunk only, no carry (marker split across chunks)**
```
(fail) pty-output-parser — turn-start edge (#562) > a marker split across two chunks is found
(fail) pty-output-parser — turn-start edge (#562) > the response slice starts at the chunk that holds the edge, not at the send
```

**F10: scan the capped footer tail instead of the chunk (marker in a large chunk)**
```
(fail) pty-output-parser — turn-start edge (#562) > a marker at the start of a chunk larger than the footer window is not lost to the tail cap
```

**F11: `runTurnWithRetries` does not retire the entry on not-accepted**
```
(fail) pty-supervisor retry and backoff > #562: a prompt claude never accepted is an error (exit 1, never 0), runs once, and retires the entry
```

**F12: final failure does not clear the input box (Ctrl-U)**
```
(fail) #562 — a turn completes only on evidence the prompt was accepted > a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it
```

## Verification runs

- New + affected PTY suites (22 files: every test importing the PTY runner/supervisor/parser):
  normally 564 pass / 0 fail, and with `CLAUDECLAW_TEST_PLATFORM=linux` the same.
  (The two `#559` failures seen mid-way were `fixtures/paste-burst-tui.ts` not painting
  running chrome; fixed, `pty-enabled-routing.test.ts` 21/21.)
- `bun run lint` (full repo, `biome check`): 0 errors (1289 warnings and 324 infos are
  pre-existing; the 7 errors that appeared mid-way were mine: 4 control-char regex and 3
  unformatted files, fixed).
- `bun run typecheck` (ratchet): 149 errors, baseline 149, no new ones.
- Run with `env -u ANTHROPIC_BASE_URL`; test output went to files, never a pipe.

## Real PTY

Not done. A real turn needs an authenticated claude; a throwaway `CLAUDE_CONFIG_DIR` has
no credentials, and the brief rules out the operator's `~/.claude`. The edge markers come
from captured 2.1.269 bytes (#369) and the 2.1.89 fixture, not from a fresh 2.1.296 /
2.1.306 capture.

## Residual risk and follow-ups (not done here)

1. **A CLI that stops painting the running chrome** would fail EVERY turn, after ~6 s, with
   `PtyPromptNotAcceptedError`. That is loud, not silent, but it is a new way for turns to
   fail. Nibbler's rerun on the fix is the check: it should show no
   `PtyPromptNotAcceptedError` on healthy turns. `submitConfirmMs` is the knob.
2. **A prompt that contains `esc to interrupt`** is echoed into the input box and forges
   the edge, for that prompt only. That is the pre-fix behaviour, not worse.
3. **`cleanBoundary=false`** (sentinel never echoed after a started turn) still returns
   partial text with exit 0 (`pty-supervisor.ts:2289`; nothing consumes the flag). The
   prompt WAS accepted, so it is not this bug, but it is the same fail-open shape.
4. **Restart: "session already in use"** (soak note) is a separate bug; untouched.
5. If the byte-stream edge proves flaky on some CLI version, Ultra's transcript user-line
   confirmation is the stronger signal for sessions that have a transcript.

No rebase and no version bump (coordinator's). No PR comments.


---

# Round 2: Codex review of `5c28206b` (4 HIGH, 2 MEDIUM) and the operator addendum

Round 2 commits on `feat/550-pty-default`: `f7cc53c9`, `0b9fdeea`, `79bd483d`, and the final
cleanup/report commit. The addendum (Terry, 2026-10-21) is binding: **the screen is never
evidence that a prompt was accepted, that a turn finished, or of what the answer was. Only
the session transcript is.** That supersedes the brief's "keep the screen for TUI-idle
timing" and its step-5 fallback, so round 1's screen-based edge detection is gone, not
patched.

## Round 2 design

### Feasibility verdict (brief step 1): small, done

| Question | Answer |
|---|---|
| Does the PTY path know the session id at turn time? | Yes, for every trusted entry: `--resume <id>` or `--session-id <uuid>` is always passed (`pty-process.ts:buildClaudeArgs`, supervisor mints one when there is none, `pty-supervisor.ts` ~1476). |
| Can the transcript path be derived? | Yes: `<CLAUDE_CONFIG_DIR or $HOME/.claude>/projects/<encodeCwdForProjectsDir(realpath(cwd))>/<id>.jsonl`. The env is the child's own env, so a throwaway config dir is honoured. |
| Does `--resume` append to the same file? | The bus path relies on it (`#402`: the transcript's session id is the stable UUID across a `--resume` restart). Not re-measured here: no authenticated claude. If it were false, every turn would fail loudly with `PtyPromptNotAcceptedError` after ~6 s, never succeed. |
| Reusable without a bus dependency? | The tailer class is bound to `BusCore`; I did not use it. `pty-transcript.ts` (new, ~300 lines) reuses two leaf exports, `encodeCwdForProjectsDir` and `isTerminalStopReason`, and reads the file itself. |
| Untrusted one-shots | `UNTRUSTED_CLAUDE_ARGS` carry `--no-session-persistence`: **there is no transcript.** Coordinator ruling A: fail closed. See "Untrusted PTY turns". |

### What a turn is now (`pty-process.ts`, `pty-transcript.ts`)

1. `TranscriptTurn.mark()` records the transcript size, THEN the prompt is written (bracketed
   paste + CR). Only bytes appended after the mark are read, so an earlier entry, even a
   byte-identical earlier prompt, can never satisfy acceptance.
2. **Accepted** = a top-level `user` entry (or a `queue-operation` `enqueue`) whose text
   matches what was written. Matching is the bus path's (`normalizePromptForMatch`):
   whitespace dropped, containment (a `<pasted_content>` wrapper is tolerated). Sub-agent
   (`isSidechain`), tool-result and compact-summary entries never match. `/compact` is matched
   by its `<command-name>`.
3. **Answer** = the assistant text of the last assistant message appended after that `user`
   entry (blocks sharing a `message.id` are joined, so an answer split across appends is
   whole). `onChunk` streams that text; `onToolEvent` streams `● Name(input)` lines from
   `tool_use` blocks.
4. **Done** = that turn's final assistant entry has a terminal `stop_reason`
   (`isTerminalStopReason`, the bus's own rule), or the CLI wrote `turn_duration`, or a
   CLI-written API-error line. `/compact`: `compact_boundary` (answer "Conversation
   compacted") or the `local_command` entry carrying the CLI's error text.
5. The submit retry and `PtyPromptNotAcceptedError` are keyed on (2): after `submitConfirmMs`
   the transcript is read once more, and only then is one bare CR written (never the prompt
   again); after another window, Ctrl-U and the error. The error says when the transcript
   held user entries that did not match.
6. The resolve waits for the screen to be quiet for `quietWindowMs`, **capped at
   `settleCapMs` (2 s)**. That is the only thing the screen still contributes to a turn and
   it is delay-only: it cannot complete a turn, change the answer, or turn a success into a
   failure (test and injection below).
7. A process with no transcript path fails in `runTurn` **before anything is written** with
   `PtyTranscriptUnavailableError`.

Removed: the sentinel round trip, `tick`/`feed`/`startTurn` use in `pty-process.ts`, the
turn-start edge, the footer/summary/title gate, `extractResponseText`/`decodeTurn` for the
answer, the `sentinelMaxWaitMs` deadline. `pty-output-parser.ts` is untouched and still
exported (it is unit-tested and the bus imports `expandCursorForwardToSpaces`/`stripAnsi`
from it); nothing that decides a turn imports its completion/answer API (guard test below).

### How each finding is closed

| # | Finding | Closed by |
|---|---|---|
| 1 | Edge markers match in echo / old text | There is no screen edge. Acceptance needs a transcript entry for this prompt; the forgery tests put each phrase in the prompt and in old assistant text. |
| 2 | Pre-edge evidence survives in the same chunk | No chunk-granular offset exists. The transcript is read by byte offset from the pre-send mark; the same bytes in any partition give the same verdict (table-driven tests). |
| 3 | Answer painted before the edge chunk is dropped | The answer is the transcript's assistant text, not a screen slice. A message split across appends is joined. |
| 4 | `cleanBoundary=false` is exit 0 | See below. |
| 5 | Fast turn / `/compact` / different chrome paints no running marker | Acceptance does not read the screen. Tests: no chrome at all, SGR inside the footer, `/compact`. |
| 6 | Tests manufacture acceptance through the prompt echo | Rewritten: fake TUIs write a real JSONL transcript (`fixtures/fake-claude-tui.ts`), prompts carry no marker phrase except in the forgery tests, and most tests put screen and transcript in disagreement. |

### Finding 4: `cleanBoundary=false` is a failure (I chose: return a complete reply, otherwise fail)

With the sentinel gone a real process now resolves only when the transcript shows the reply
complete, so `cleanBoundary` is `true` and `replyComplete` is `true` from `PtyProcess`. The
failure path is kept for any `PtyProcess` that reports otherwise, in BOTH callers, via one
shared `boundaryVerdict(result)`:

- `cleanBoundary=false` and no `replyComplete`: **failure**, entry retired, never resubmitted
  (the turn may have run). `runTurnWithRetries`: exit 1, "boundary unconfirmed".
  `sendToLiveSession`: `status: "failed"`, which `live-session-actions.ts` already maps to
  `ok: false`.
- `cleanBoundary=false` and `replyComplete: true` (the transcript shows a complete reply):
  **success with the answer, and the entry is still retired**, because the TUI never
  confirmed it was idle. This is the "return it as success" option the brief allowed; I
  chose it because a complete assistant reply is the answer and discarding it would be
  silent loss the other way.

### Untrusted PTY turns (coordinator ruling A)

A PTY turn with no transcript fails closed with `PtyTranscriptUnavailableError`
(`"... an untrusted one-shot runs with --no-session-persistence"`). Nothing is written to the
PTY first, so the input box is untouched. This breaks nothing live on this branch: the PTY
engine has `caps.isolation=false` (`src/oneshot/registry.ts:21-23`), so untrusted one-shots
route to `print`. **Follow-up for #570 / #581** (which enable untrusted PTY): untrusted calls
must be given a transcript, i.e. run in the throwaway `CLAUDE_CONFIG_DIR` with session
persistence on, instead of `--no-session-persistence`. Not done here (ruling: not B).

## Remaining screen uses, by permitted category (addendum point 5)

| Use | Where | Category | Can it complete a turn? |
|---|---|---|---|
| Boot readiness: wait for the TUI to settle, "tab to cycle" footer | `pty-process.ts` `_waitForReadySettle` (~1100-1200) | readiness | No: before any turn |
| Boot dialogs: Bypass Permissions, project-MCP approval, trust prompt; answered with a key | `_waitForReadySettle`, `pty-trust-prompt.ts` | dialogs | No |
| PTY exit and the credential-redacted tail for the "exited before TUI settled" error | `_handleExit`, `_appendToTail`, `_readTailSnapshot` | liveness | No: it can only FAIL a turn (`PtyClosedError`) |
| Last-paint timestamp, to wait for a repaint to quiet before resolving | `_handleData` `_lastDataAt`, `_tick` | timing / readiness | **No.** Gated by the transcript; waits at most `settleCapMs`; delay-only |
| Ctrl-U to empty the input box after a failed turn | `_clearInputBox` | input hygiene on failure | No |
| `CLAUDECLAW_PTY_DUMP` raw trace | `dumpPtyTrace` | diagnostics | No |
| Bus: boot-dialog gates, idle footer latch | `src/bus/session-agent-process.ts` (not touched) | readiness / dialogs | Out of scope: not the runner's turn path |

`pty-process.ts` imports exactly one thing from the screen parser: `stripAnsi`, for the boot
text. The guard test lists the rest as forbidden.

## Guard test (addendum point 4)

`src/__tests__/pty-turn-evidence-guard.test.ts` reads the source of
`pty-process.ts`, `pty-transcript.ts`, `pty-supervisor.ts` and `live-session-actions.ts` and
fails if any imports, re-exports, `require`s or dynamic-imports the screen parser's
completion/answer API. Forbidden symbols: `createParser`, `startTurn`, `feed`, `tick`,
`markSentinelWritten`, `resetTurn`, `buildSentinel`, `encodeSentinel`, `extractResponseText`,
`decodeTurn`, `normaliseNewlines`, `Parser`, `ParserEvent`, `ParserState`. Allowed readiness
helpers: `stripAnsi`, `DEFAULT_QUIET_WINDOW_MS`. It scans text rather than the module graph
so a barrel cannot hide a re-export. It also tests itself (10 shapes it must flag, one it
must allow). Injection I15 below adds `feed` to the `pty-process.ts` import: RED.

The rule is recorded in `.planning/pty-migration/SPEC.md` (new file, frozen decision 1;
the long-form SPEC the global rules mention is not in this tree) and in `CLAUDE.md`
("PTY turn evidence", rule verbatim).

## Round 2: fault injection (one site at a time, on a `git archive` copy of the commit)

Each injection was applied with an exact-match assertion (the driver fails if the text to
change is not found exactly once), then the named test files were run. Lines are verbatim
from those runs (first four failures of each; the count is the total). Every injection went
RED. One did not on its first try, and was fixed first: I19 (a "strip the
`<pasted_content>` wrapper" step survived the injection because containment already tolerates
the wrapper, so the step was dead code and was deleted; the injection now targets
containment itself).

```
## I1 screen marker forges acceptance + end: exit=1 failing=16
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt and old assistant text containing "esc to interrupt": the turn is NOT done [192.41ms]
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt and old assistant text containing "esc cancel": the turn is NOT done [114.42ms]
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt and old assistant text containing "Compacting conversation": the turn is NOT done [118.76ms]
```

```
## I2 mark() at offset 0 (earlier entries count): exit=1 failing=3
   (fail) TranscriptTurn — acceptance > an EARLIER identical prompt does not count: only bytes after the mark are read [2.43ms]
   (fail) #562 — the screen is never evidence the prompt was accepted > an earlier identical prompt and its answer in the transcript are not this turn [133.33ms]
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it [635.66ms]
```

```
## I3 torn trailing line is dropped, not carried: exit=1 failing=6
   (fail) TranscriptTurn — delivery shape never changes the verdict > two halves: same verdict and answer as one write [0.89ms]
   (fail) TranscriptTurn — delivery shape never changes the verdict > five parts: same verdict and answer as one write [0.55ms]
   (fail) TranscriptTurn — delivery shape never changes the verdict > a cut inside every line: same verdict and answer as one write [0.54ms]
```

```
## I4 repeated message id replaces instead of joining: exit=1 failing=10
   (fail) TranscriptTurn — answer and end of reply > blocks of ONE message arriving over separate polls are joined, in full [4.23ms]
   (fail) TranscriptTurn — delivery shape never changes the verdict > one write: same verdict and answer as one write [0.45ms]
   (fail) TranscriptTurn — delivery shape never changes the verdict > two halves: same verdict and answer as one write [0.40ms]
```

```
## I5 assistant lines count before the user entry: exit=1 failing=1
   (fail) TranscriptTurn — answer and end of reply > an assistant entry BEFORE the user entry is not this turn's answer [4.66ms]
```

```
## I6 screen quiet after acceptance completes the turn: exit=1 failing=14
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it [755.41ms]
   (fail) #562 — a turn is over only when the transcript says so > accepted, and the screen shows the answer and done chrome, but the reply has no stop: NOT done [120.72ms]
   (fail) #562 — a turn is over only when the transcript says so > the answer is the transcript's, not the screen's [116.30ms]
```

```
## I7 submit retry ignores the transcript (acceptance): exit=1 failing=6
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it [620.11ms]
   (fail) #562 — a turn is over only when the transcript says so > accepted, and the screen shows the answer and done chrome, but the reply has no stop: NOT done [824.99ms]
   (fail) #562 — the same transcript, delivered in any shape, gives the same verdict and answer > byte-sized fragments over the last block [818.21ms]
```

```
## I8 submit retry re-writes the prompt: exit=1 failing=1
   (fail) #562 — the submit retry > evidence that arrives AFTER the confirm deadline: no duplicate submission [406.86ms]
```

```
## I9 submit retry CR deleted: exit=1 failing=3
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it [671.89ms]
   (fail) #562 — the submit retry > paste swallowed once, the retry lands: completes with only the new output [461.77ms]
   (fail) #562 — the submit retry > evidence that arrives AFTER the confirm deadline: no duplicate submission [457.77ms]
```

```
## I10 Ctrl-U not sent on not-accepted: exit=1 failing=1
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it [3427.27ms]
```

```
## I11 quiet window gates completion (no cap): exit=1 failing=1
   (fail) #562 — the screen's only say is timing, and it can only delay > a screen that never goes quiet still resolves with the transcript answer after the cap [5001.17ms]
```

```
## I12 no-transcript refusal removed: exit=1 failing=3
   (fail) #562 — the screen is never evidence the prompt was accepted > a prompt that is never accepted clears the input box before failing, so the next CR cannot submit it [624.27ms]
   (fail) #562 — a process with no transcript cannot succeed > an untrusted PTY turn errors before anything is written and never resolves from the screen [1052.53ms]
   (fail) #562 — a process with no transcript cannot succeed > a hooked process given no transcriptPath is refused the same way [818.45ms]
```

```
## I13a runTurnWithRetries ignores cleanBoundary: exit=1 failing=2
   (fail) pty-supervisor retry and backoff > #562 round 2: an unconfirmed turn boundary is an error (exit 1), runs once, and retires the entry [1.71ms]
   (fail) pty-supervisor retry and backoff > #562 round 2: an unconfirmed boundary whose transcript shows a COMPLETE reply is returned, and the entry is retired [1.73ms]
```

```
## I13b sendToLiveSession ignores cleanBoundary: exit=1 failing=2
   (fail) sendToLiveSession > #562 round 2: an unconfirmed turn boundary reports failed (not sent) and retires the entry [2.16ms]
   (fail) sendToLiveSession > #562 round 2: an unconfirmed boundary with a COMPLETE transcript reply is sent, and the entry is retired [1.93ms]
```

```
## I14a runTurnWithRetries does not retire on unconfirmed: exit=1 failing=2
   (fail) pty-supervisor retry and backoff > #562 round 2: an unconfirmed turn boundary is an error (exit 1), runs once, and retires the entry [0.95ms]
   (fail) pty-supervisor retry and backoff > #562 round 2: an unconfirmed boundary whose transcript shows a COMPLETE reply is returned, and the entry is retired [0.86ms]
```

```
## I14b sendToLiveSession does not retire on unconfirmed: exit=1 failing=2
   (fail) sendToLiveSession > #562 round 2: an unconfirmed turn boundary reports failed (not sent) and retires the entry [0.90ms]
   (fail) sendToLiveSession > #562 round 2: an unconfirmed boundary with a COMPLETE transcript reply is sent, and the entry is retired [0.59ms]
```

```
## I15 guard: parser completion API imported into pty-process: exit=1 failing=1
   (fail) PTY turn evidence: the modules that decide success do not read the screen parser's completion API > src/runner/pty-process.ts imports nothing from the parser's completion/answer API [5.18ms]
```

```
## I16 /compact never matches its command entry: exit=1 failing=3
   (fail) TranscriptTurn — /compact > accepted by the command entry, ended by compact_boundary [0.49ms]
   (fail) TranscriptTurn — /compact > a failed compact ends on its local_command error, carrying the CLI's text [0.35ms]
   (fail) #562 — acceptance does not depend on the screen painting anything > /compact: accepted by its command entry, ended by compact_boundary, not re-submitted or rejected [421.83ms]
```

```
## I17 onChunk not fed from the transcript: exit=1 failing=1
   (fail) #562 — a turn is over only when the transcript says so > onChunk streams the assistant's own text from the transcript [280.82ms]
```

```
## I18 whitespace collapsed to one space instead of dropped: exit=1 failing=1
   (fail) TranscriptTurn — acceptance > a TAB in the prompt, which the TUI turns into a completion key, does not stop it matching [9.11ms]
```

```
## I19 containment replaced by equality (wrapped prompt no longer matches): exit=1 failing=2
   (fail) TranscriptTurn — acceptance > the prompt may arrive wrapped (a paste wrapper, a prefix): containment, whitespace-insensitive [0.39ms]
   (fail) TranscriptTurn — acceptance > a prompt the CLI recorded as a paste is wrapped in pasted_content tags and still matches [0.29ms]
```

## Round 2: verification

- Affected suites: every test importing the PTY runner/supervisor/parser plus the new files
  and the gateway seam test (27 files), on the final commit: **663 pass / 0 fail**, both
  normally and with `CLAUDECLAW_TEST_PLATFORM=linux`. Earlier runs on this branch hit two
  timing-sensitive tests under parallel load, neither a regression: the #469 "dialog that
  paints late" test (a fake dialog script exited 1 when its Esc was late; `_waitForReadySettle`
  is untouched by round 2; it passed 3/3 alone) and the Ctrl-U test (racy because the fake
  was disposed with the error; rewritten to keep it alive until the byte is recorded, 5/5
  after, and its injection is still RED).
- A full-repo `bun test` run before the final fixes showed 5 failures: the two #559 tests
  (the stand-in TUI wrote no transcript; fixed, 21/21), the late-dialog flake above, and two
  gateway tests failing with "System is paused": an escalation test in the full run had
  written `.claude/claudeclaw/paused.json` ("Watchdog suspend: Test") into this worktree. It
  is gitignored runtime state, not code; I deleted it and the tests pass. It will recur on
  any full-suite run in this worktree (pre-existing cross-test pollution).
- `bun run lint` (full repo): 0 errors (1291 warnings, 324 infos, pre-existing).
  `bun run typecheck`: 149 errors, baseline 149.
- Run with `env -u ANTHROPIC_BASE_URL`; test output went to files, never a pipe.

## Not done / risks

1. **No real claude.** Nothing here was run against an authenticated CLI. The assumptions
   that only a real run can confirm: `--resume` appends to the same transcript file; the
   transcript records a pasted prompt in a form the bus-style containment match accepts;
   the final assistant line of a turn carries a terminal `stop_reason` (or `turn_duration`
   follows). Each fails LOUD: `PtyPromptNotAcceptedError` after ~6 s, or a turn that runs to
   its own `timeoutMs`; none can succeed falsely. Nibbler's rerun should show no
   `PtyPromptNotAcceptedError` on healthy turns.
2. A turn whose terminal marker is never written would now wait for the caller's
   `timeoutMs`, where the screen used to end it early. That is the cost of the ruling.
3. `submitConfirmMs` (3 s) assumes the CLI writes the `user` entry within that. The bus
   measured p95 0.25 s for an idle session; a prompt queued behind a running turn has an
   `enqueue` record (also accepted) but its `user` entry can be minutes late. The runner
   serialises turns per session, so this should not arise.
4. Untrusted PTY (above) is a follow-up for #570 / #581.
5. `sentinelMaxWaitMs`, `turnIdleTimeoutMs` and `quietWindowMs` remain in settings so
   existing files parse; `sentinelMaxWaitMs` is now unused and `quietWindowMs` is the
   readiness wait.
