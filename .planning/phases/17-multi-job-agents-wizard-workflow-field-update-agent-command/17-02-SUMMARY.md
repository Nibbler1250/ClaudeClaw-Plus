---
phase: 17-multi-job-agents-wizard-workflow-field-update-agent-command
plan: 02
subsystem: agents
tags: [cron, nl-parser, scheduling, tdd]

requires:
  - phase: 16-create-agent-command
    provides: parseScheduleToCron base function with 9 NL presets
provides:
  - parseScheduleToCron handles 13 additional NL patterns
  - Multi-time-per-day cron generation (e.g. 9am, 1pm, 5pm)
  - Named time keywords (noon, midnight, morning, evening, night)
  - every N hours preset
  - safeCron output validation helper
affects: [17-03-wizard, 17-04-update-agent, 17-05-migration]

tech-stack:
  added: []
  patterns:
    - "Hand-rolled regex parser (no NL library) per Phase 16 inheritance"
    - "Output validation via cronMatches before return (defensive)"

key-files:
  created: []
  modified:
    - src/agents.ts
    - src/__tests__/agents.test.ts

key-decisions:
  - "twice daily = 9,21; thrice daily = 9,13,17 (hard-coded standard slots)"
  - "Tightened RAW_CRON_RE to cron-valid chars only — prevents 'every day at 7 pm' from false-matching as raw cron"
  - "Stricter am/pm hour validation (1..12) to reject 'every day at 25pm'"

patterns-established:
  - "safeCron helper: validate generated cron via cronMatches before returning, return null on throw"

requirements-completed: [CRON-01]

duration: 8 min
completed: 2026-04-07
---

# Phase 17 Plan 2: NL→cron parser broadening Summary

**parseScheduleToCron now handles 13 additional NL patterns including multi-time-per-day, named times, and every-N-hours, with hardened validation that rejects malformed inputs.**

## Performance

- **Duration:** 8 min
- **Tasks:** 1 (TDD)
- **Files modified:** 2
- **Test count:** 65 pass / 0 fail in agents.test.ts (was 45 pass)
- **Full suite:** 635 pass / 13 pre-existing fail (was 615/628 — no regressions)

## Accomplishments
- Extended `parseHour` with named times (noon, midnight, morning, evening, night) and stricter am/pm validation
- Added presets: `twice daily`, `thrice daily`, `every weekend`
- Added `every N hours` parser (1..23)
- Added multi-time-per-day parser supporting both `and` and `,` separators
- Tightened raw-cron passthrough regex to cron-valid characters only
- Added `safeCron` helper for defensive output validation

## Task Commits

1. **RED — failing tests** — `2957a54` (test)
2. **GREEN — parser broadening** — `20a7253` (feat)

No refactor pass needed — implementation was already minimal and clear.

## Files Created/Modified
- `src/agents.ts` — parseHour extended, RAW_CRON_RE tightened, 4 new branches added, safeCron helper introduced
- `src/__tests__/agents.test.ts` — new `Phase 17: parseScheduleToCron broadening` describe block with 20 table-driven cases

## Decisions Made
- **N-times-daily slots hard-coded** (twice=9,21; thrice=9,13,17) — matches plan spec, no config needed yet
- **RAW_CRON_RE tightened** to `[\d*,\-/]+` per field — discovered during GREEN that "every day at 7 pm" was false-matching as raw cron because it has 5 whitespace-separated tokens. Tightening prevents future ambiguity and aligns with `validateCronOrThrow` semantics already in the file.
- **am/pm range enforced (1..12)** — needed to reject "every day at 25pm". Without it, "25pm" became `25+12=37` then failed the 0..23 check anyway, but the explicit guard is clearer and rejects "0am" too.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] RAW_CRON_RE false-match on space-separated NL phrases**
- **Found during:** Task 1 GREEN phase (one test failing after initial implementation)
- **Issue:** "every day at 7 pm" has exactly 5 whitespace-separated tokens, so `RAW_CRON_RE = /^(\S+)\s+(\S+).../` matched and the input was returned as-is. Pre-existing bug — Phase 16 just never tested an NL input that happened to have 5 tokens.
- **Fix:** Tightened the regex to `[\d*,\-/]+` per field so only actual cron characters match.
- **Files modified:** src/agents.ts
- **Verification:** All 65 tests green; full suite shows no new failures.
- **Committed in:** 20a7253 (Task 1 GREEN commit)

**2. [Rule 1 - Bug] am/pm hour range not validated**
- **Found during:** Task 1 GREEN phase (negative case "every day at 25pm" needed to return null)
- **Issue:** parseHour accepted any 1-2 digit hour with am/pm, then "25pm" became 37 and was caught by the final 0..23 check — works by accident but unclear.
- **Fix:** Added explicit `if (h < 1 || h > 12) return null` before the meridiem adjustment.
- **Files modified:** src/agents.ts
- **Verification:** Negative test cases pass.
- **Committed in:** 20a7253 (Task 1 GREEN commit)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both fixes were necessary for correctness and improved the parser's clarity. No scope creep — both within the parser-broadening task.

## Issues Encountered
None.

## User Setup Required
None.

## Next Phase Readiness
- CRON-01 complete: every documented NL pattern parses to a valid cron string
- Wizard (17-03) and update-agent (17-04) plans can now rely on the broadened parser
- Ready for 17-03

---
*Phase: 17-multi-job-agents-wizard-workflow-field-update-agent-command*
*Completed: 2026-04-07*

## Self-Check: PASSED
- src/agents.ts exists
- src/__tests__/agents.test.ts exists
- Commits 2957a54 (RED) and 20a7253 (GREEN) verified in git log
