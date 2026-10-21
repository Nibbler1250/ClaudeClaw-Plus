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
