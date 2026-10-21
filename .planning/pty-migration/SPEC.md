# PTY migration: SPEC (frozen decisions)

> Only the section below is recorded here. The long-form SPEC referred to in
> `~/.claude/rules/sdc.md` is not in this tree; this file was created for the #562 round-2
> ruling so the decision has a home. Extend it, do not replace it.

## Architecture decisions (frozen)

Decisions not to be re-litigated, each with its rationale.

1. **PTY turn evidence comes from the session transcript, never the screen.** The screen is never evidence that a prompt was accepted, that a turn finished, or of what the answer was. Only the session transcript is. The screen may be used for readiness, dialogs and liveness, and only to stop or fail a turn, never to mark it successful.
   Rationale: #559 and the #562 soak showed repaints, chunk splits, prompt echo and CLI chrome changes each producing a false success; the transcript-reading bus path went 99/99. Enforced by `src/__tests__/pty-turn-evidence-guard.test.ts`. (Operator ruling, Terry, 2026-10-21.)
