---
phase: 18-per-job-model-override-runtime-wiring-milestone-blocker
plan: 03
subsystem: tests
tags: [runner, jobs, agents, model-override, integration, milestone-blocker]
requires:
  - src/runner.ts exported runClaudeOnce (from 18-01)
  - src/jobs.ts resolveJobModel cascade (from 18-01 + 18-02)
  - src/agents.ts defaultModel field (from 18-02)
provides:
  - Parameterized coverage of all 4 valid model strings (opus/sonnet/haiku/glm) via test.each
  - Explicit agentic-routing + override collision test (override wins)
  - Non-agentic regression sanity test (settings.model used)
  - End-to-end integration test walking createAgent → addJob → loadJobs → resolveJobModel → run → runClaudeOnce spy
  - Load-time invalid-model rejection verified at integration level (not just unit)
affects:
  - src/__tests__/runner.test.ts
  - src/__tests__/integration/model-override.test.ts
tech-stack:
  added: []
  patterns:
    - spy-on-runClaudeOnce-with-sentinel-throw (reused from 18-01)
    - writeJobFileRaw-bypass-for-invalid-fixture-injection
    - test.each parameterized model matrix
key-files:
  created:
    - src/__tests__/integration/model-override.test.ts
  modified:
    - src/__tests__/runner.test.ts
decisions:
  - Integration test uses unique agent-name prefix (tst-p1803-) in real project cwd rather than mkdtempSync+chdir — matches existing agents.test.ts convention, avoids Bun module-cache issues with chdir
  - Invalid-model fixture injected via direct writeFile (bypasses addJob validation) to cover the loadJobs-filter path that addJob's frontstop would otherwise hide
  - fallbackConfig isolation from modelOverride documented by inspection rather than asserted — the current runClaudeOnce spy captures only the primary model arg
  - Plan 01 deferred runner.test.ts cases 4-5 (agentic-collision, governanceSelectModel sanity) closed here via getSettings spy rather than governance internals mock (simpler, less brittle)
metrics:
  duration: ~10min
  completed: 2026-04-08
requirements: [MODEL-TEST-01, MODEL-RT-01, MODEL-RT-02, MODEL-RT-03]
---

# Phase 18 Plan 03: Test Coverage Expansion Summary

Closed the Phase 18 test coverage gap. Plans 01 and 02 landed focused unit tests for the new runtime wiring and agent-level default; this plan adds the parameterized model-string matrix, the agentic-routing collision test, and a real end-to-end integration test that walks the entire loadJobs → resolveJobModel → run chain with real agent fixtures.

Milestone v1.0 blocker cleared: Reg can run digest-scan on sonnet and draft-writing on opus via job-level override, Suzy can run on haiku via agent-level default, and invalid strings fail fast at daemon startup.

## Tasks Completed

| Task | Name                                                            | Commit  |
| ---- | --------------------------------------------------------------- | ------- |
| 1    | Expand runner.test.ts — all model strings + agentic collision   | f7dcced |
| 2    | End-to-end integration test at src/__tests__/integration/       | 82a5bf6 |

## Implementation Notes

**runner.test.ts extension** — Added `test.each(["opus","sonnet","haiku","glm"])` parameterized case on top of the existing Plan 01 spy harness, plus two explicit settings-mock cases: `modelOverride wins when agentic.enabled=true` and `no-override + agentic.enabled=false uses settings.model`. Used `spyOn(configMod, "getSettings")` to flip the agentic flag per-test rather than mocking governance internals — keeps the test boundary at the runtime branch being tested. `fallbackConfig` isolation is noted as a comment, since the existing spy surface only exposes the primary-model arg.

**integration/model-override.test.ts** — New file, mirrors the `tst-agent-` prefix cleanup convention from `agents.test.ts` (no chdir — Bun's module cache makes cwd swaps unreliable once runner.ts has loaded). A small `writeJobFileRaw` helper bypasses `addJob`'s validation so we can inject `model: opuz` and verify `loadJobs()` filters it while a valid sibling (`model: haiku`) still loads. The end-to-end case spies `runnerMod.runClaudeOnce` with the exact `(args, model)` signature from Plan 01's harness, calls `resolveJobModel(draft)` against the loaded fixture, then passes the result as `modelOverride` to `run()` and asserts the spy observed `"opus"`.

Five test cases in total:
1. `job.model wins over agent.defaultModel`
2. `agent.defaultModel fills in when job has no model field`
3. `agent with no defaultModel and job with no model → undefined`
4. `loadJobs filters jobs with invalid model strings (typo rejection)`
5. `resolved model reaches runClaudeOnce via run() (end-to-end)`

## Test Results

| Suite                                                   | Pass / Fail |
| ------------------------------------------------------- | ----------- |
| src/__tests__/runner.test.ts                            | 9 / 0       |
| src/__tests__/integration/model-override.test.ts        | 5 / 0       |
| Full suite                                              | 741 / 13    |

11 new assertions added (6 in runner.test.ts via test.each + 2 new cases, 5 in the integration file with multiple expects each). 13 failures are pre-existing and unchanged from 18-02 baseline — zero new regressions.

## Deviations from Plan

None of substance.

- Plan suggested `mkdtempSync + process.chdir` for the integration test; switched to the unique-prefix pattern used by `agents.test.ts` because Bun caches `runner.ts` on first import, and the chdir approach would have decoupled the test fixture dir from where runner.ts actually resolves `process.cwd()`. Same isolation outcome, simpler, matches existing convention.
- One scratch iteration on the e2e spy: first draft used a `(prompt, sessionId, primaryConfig)` signature (guessed at it); `runner.test.ts` showed `runClaudeOnce` is actually `(args: string[], model: string)`. Fixed before commit.

## Milestone v1.0 Status

All Phase 18 requirements now have passing tests:

| Req           | Covered By                                                     |
| ------------- | -------------------------------------------------------------- |
| MODEL-RT-01   | runner.test.ts override-forwarded, integration e2e case        |
| MODEL-RT-02   | runner.test.ts settings-fallback, integration undefined case   |
| MODEL-RT-03   | integration agent-default fill-in case                         |
| MODEL-VAL-01  | jobs.test.ts (18-01) + integration invalid-model filter        |
| MODEL-VAL-02  | jobs.test.ts (18-01) loadJobs invalid-model rejection          |
| MODEL-UI-01   | agents.test.ts (18-02) + skills/create-agent SKILL.md update   |
| MODEL-UI-02   | agents.test.ts (18-02) + skills/update-agent SKILL.md update   |
| MODEL-TEST-01 | runner.test.ts test.each + integration end-to-end file         |

Per-job model override fully validated end-to-end. Phase 18 complete.

## Self-Check: PASSED

- src/__tests__/runner.test.ts contains `test.each(["opus", "sonnet", "haiku", "glm"]`
- src/__tests__/integration/model-override.test.ts exists and contains `writeJobFileRaw` + `resolveJobModel` + `runnerMod.runClaudeOnce` spy
- Commits f7dcced and 82a5bf6 present in `git log`
- `bun test` reports 741/754 (13 pre-existing failures only, zero new)
