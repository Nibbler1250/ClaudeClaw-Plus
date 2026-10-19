# Issue #550 implementation report

Implemented on `feat/550-pty-default` from `povai/main` at `d81bd579`. The testable requirements are implemented. Merge and rollout remain blocked on the independently owned #559 fix, the #548/#549 utility dependencies, and the operator's 48-hour soak. README.md is deliberately untouched because PR #558 owns its rewrite.

## Changes

- DEFAULT_SETTINGS.pty.enabled is true, including freshly generated settings. Missing values default true; literal false is preserved; invalid enabled values warn without logging the supplied value.
- defaultSupervisionFor selects pty-stdin for every BusOrigin (discord, telegram, slack, webui, cron, heartbeat, cli, rest). Explicit agent supervision, including process-stream-json, remains authoritative.
- Bootstrap now follows the same configured engine as other agent turns. Primary-corruption, stale-session and post-compaction retries route through a shared recovery helper. PTY recovery retires the old process before reading the reset session store or resuming the compacted transcript. Explicit print recovery remains supported and tested.
- Startup emits the effective runner-turn, cron-job and bus non-channel default engines, plus every declared agent's supervision override.
- docs/pty-migration.md explains upgrade behavior, both print opt-outs, restart requirements and startup/spawn/process verification. The job-loop comment and warning now accurately describe the configured engine.
- Print-specific bus fixtures explicitly request process-stream-json. Existing runner default/bootstrap assertions were updated. The #559 restoreDir defect was not changed; its routing suite was run in an isolated temporary cwd to protect developer state.
- Both plugin manifests were bumped with the prescribed scripts; the branch is at 2.2.341 (main is 2.2.340).

## Bus confirmation and cron proof

The due-job test drives createJobLoop.tick into the actual runner with freshly generated defaults. Its execution seams record a PTY call and zero print calls; the explicit-false control records one print call and zero PTY calls.

The cron and dispatched-job-result tests use createBusCore, createPromptStreamHandler, the real PtyAgentProcess confirmation loop, and receipt storage. A fake PTY records the submitted envelope and feeds an actual PromptIngestion observation back to the process. Both return turn-started and stamp that verdict in the receipt. Dispatched jobs currently return to their dispatcher using origin=cron and origin_id=agent-job:<id>; the test exercises deliverAgentJobResult rather than introducing a new job origin. The headless job-worker engine is separately covered by the existing #546 routing suite.

## Validation

All test runners were invoked directly, with output captured and summarized in context-mode; none were piped to head/tail. The full suite was not run because of the documented cross-test pollution.

| Command | Result |
| --- | --- |
| `bun test src/__tests__/pty-config.test.ts src/__tests__/pty-default-runner.test.ts src/__tests__/execution-engines.test.ts src/__tests__/job-loop.test.ts` | 105 pass, 0 fail |
| `bun test src/bus/__tests__/agent-resolver.test.ts src/bus/__tests__/pty-default-delivery.test.ts src/bus/__tests__/wiring.test.ts src/bus/__tests__/scheduler-wiring.test.ts` | 34 pass, 0 fail |
| `bun test src/bus/__tests__/build-claude-args.test.ts src/bus/__tests__/agent-job-delivery.test.ts src/bus/__tests__/runtime-mount.test.ts` | 43 pass, 0 fail |
| `bun test src/bus/__tests__/session-manager.test.ts` | 48 pass, 0 fail, 95.37 seconds |
| `bun test <absolute path>/src/__tests__/pty-enabled-routing.test.ts` in isolated temp cwd with src symlink | 18 pass, 0 fail |
| `bun test <absolute path>/src/__tests__/pty-backward-compat.test.ts` in isolated temp cwd with src symlink | 8 pass, 0 fail |
| `bun run lint` over the whole repository (JSON reporter for final diagnostic summary) | exit 0; 0 errors, advisory warnings remain |
| `bun run typecheck` | baseline and final: 149 diagnostics against baseline 149; exit 0 |
| `git diff --check` | clean |
| both version bump scripts | 2.2.341 |

The initial 55-second cap on the session-manager file was inadequate after lifecycle fixtures began using PTYs by default; the complete scoped rerun passed in 95.37 seconds. The earlier capped invocation was not counted as a pass. No live Claude model turn or production daemon check was performed. CLI 2.1.302 is installed, but #559 is an existing independently owned merge blocker; no claim of resolving or live-verifying it is made here.

## TDD and fault injection

Before implementation, config/default tests failed with Expected true / Received false, the non-channel origin test failed with Expected pty-stdin / Received process-stream-json, bootstrap reported legacy, and all three recovery route tests recorded zero PTY calls. The startup tests initially failed because execution-engines.js did not yet exist.

Seventeen independent faults were injected and reverted in finally blocks. Each regression below is a verbatim RED runner line. The duplicate startup-log probe was repeated after making its assertion produce compact failure output.

### generated default

```text
(fail) #550 default runner routing > a due cron job reaches PTY with freshly generated defaults [177.49ms]
```

### missing/invalid parser default

```text
(fail) parseSettings — pty defaults > applies all defaults when pty block is missing [8.67ms]
```

### explicit false opt-out

```text
(fail) parseSettings — pty defaults > respects an explicit pty.enabled = false [9.56ms]
```

### invalid setting warning

```text
(fail) parseSettings — pty defaults > warns and uses the default for invalid enabled="false" [22.18ms]
(fail) parseSettings — pty defaults > warns and uses the default for invalid enabled=0 [2.64ms]
(fail) parseSettings — pty defaults > warns and uses the default for invalid enabled=null [5.08ms]
(fail) parseSettings — pty defaults > warns and uses the default for invalid enabled={} [1.95ms]
(fail) parseSettings — pty defaults > warns and uses the default for invalid enabled=[] [3.17ms]
```

### bus default every origin

```text
(fail) defaultSupervisionFor > returns pty-stdin for channel-driven origins [1.57ms]
(fail) defaultSupervisionFor > returns pty-stdin for non-channel origins [0.13ms]
```

### explicit bus agent print mode

```text
(fail) process-stream-json supervision > keeps explicit process-stream-json for cron origin [2231.85ms]
```

### bootstrap route

```text
(fail) #550 default runner routing > bootstrap follows PTY rather than an unconditional print exception [261.65ms]
```

### corruption retry

```text
(fail) #550 default runner routing > corrupt retry retires the old PTY and follows the configured engine [197.28ms]
```

### stale retry

```text
(fail) #550 default runner routing > stale retry retires the old PTY and follows the configured engine [131.74ms]
```

### post-compact retry

```text
(fail) #550 default runner routing > compact retry retires the old PTY and follows the configured engine [166.36ms]
```

### retire failed PTY before recovery

```text
(fail) #550 default runner routing > corrupt retry retires the old PTY and follows the configured engine [120.42ms]
(fail) #550 default runner routing > stale retry retires the old PTY and follows the configured engine [83.73ms]
(fail) #550 default runner routing > compact retry retires the old PTY and follows the configured engine [114.50ms]
```

### startup log wiring

```text
(fail) #550 startup engine summary > startup actually emits the summary [41.19ms]
```

### bus prompt-ingestion confirmation

```text
(fail) #550 non-channel PTY delivery > cron reaches the #361 loop and confirms from actual prompt ingestion [253.81ms]
(fail) #550 non-channel PTY delivery > agent-job reaches the #361 loop and confirms from actual prompt ingestion [224.21ms]
```

### startup effective engine values

```text
(fail) #550 startup engine summary > names the runner, cron and bus default engines [14.21ms]
```

### agent resolver print override

```text
(fail) resolveBusAgentConfig — defaults > keeps the explicit process-stream-json opt-out [10.83ms]
```

### startup log wiring (compact assertion)

```text
(fail) #550 startup engine summary > startup actually emits the summary [3.83ms]
```

### recovery explicit print selection

```text
(fail) #550 default runner routing > corrupt retry preserves the explicit print opt-out [217.24ms]
(fail) #550 default runner routing > stale retry preserves the explicit print opt-out [131.38ms]
(fail) #550 default runner routing > compact retry preserves the explicit print opt-out [120.82ms]
```

## Remaining print-path inventory

Line numbers below refer to the delivered source; utility migrations are not duplicated in this branch.

| Path | Remaining print behavior and reason |
| --- | --- |
| src/runner.ts:913, buildAgentJobArgs / runAgentJobHeadless | Explicit pty.enabled=false path only; default headless jobs take ephemeral PTY before the builder runs. |
| src/runner.ts:1927, primary args / runClaudeStream | Args are still constructed for compatibility; execution selects print only for explicit pty.enabled=false. Bootstrap follows this same guard. |
| src/runner.ts:2156, fallback args | Print only when the primary route is explicit legacy; the default fallback uses its own PTY/session store. |
| src/runner.ts, execRecovery | runClaudeStream is gated by the same explicit legacy selection. Corruption/stale/post-compaction retries use PTY by default. |
| src/runner.ts:2785, streamClaude | Explicit legacy branch only; default dashboard/chat streaming returns through execClaude on PTY before this print spawn. |
| src/runner.ts:3102, runFork | Explicit legacy branch only; default forks use an ephemeral PTY outside the main LRU/kill scope. |
| src/bus/session-manager.ts:669 | -p flags only for explicit process-stream-json supervision. Every origin now defaults PTY. |
| src/runner.ts:1581, runCompact | Trusted-session utility; #549 owns the live-PTY and runOneShot migration. This default flip does not duplicate it. |
| src/runner.ts:2554, precompact memory save | Trusted-session utility owned by #549. |
| src/rotation.ts:93 | Trusted-session rotation-summary utility owned by #549. |
| src/commands/stop.ts:54 | Shutdown memory-save utility owned by #549. |
| src/commands/discord.ts:592 | Untrusted classifier; #548 centralises it. Untrusted routes must stay print until the PTY isolation spike is green. |
| src/skills-tuner/core/llm.ts:38 | Untrusted tuner CLI backend; #548 centralises it and keeps claude_cli as the supported print alias. |
| tools/memory-search/memory_search/recall.py:79 | Untrusted standalone Python recall summarizer; #545 isolation must remain intact and #548 keeps parity. |

The historical -p mention in src/bus/agent-jobs.ts is a comment about old fire scripts, not a remaining spawn. The operator goal of no default print agent turns is implemented; utility print calls remain explicit scope/dependency exceptions, not silently converted to unverified untrusted PTYs.

## Exact operator 48-hour soak checklist

Do not start this soak until #559 is merged and verified and the #548/#549 dependencies are integrated.

1. Record deployment commit, plugin/marketplace versions, Claude CLI version, UTC start time and intended end time at least 48 hours later. Save the engine settings used. Use default PTY settings with no unintended process-stream-json overrides.
2. Restart the daemon. Capture the startup engine summary and per-agent spawn logs. Verify the declared overrides match the actual processes; record PIDs and whether a print flag is present, without copying whole command lines or credentials into the report.
3. On a fresh session, send ordinary channel chat through runUserMessage with its real timestamp prefix intact. Confirm submission, one reply and completion before the timeout. Repeat across configured channels. Any recurrence of #559 fails the soak.
4. Allow due cron jobs to execute repeatedly across the 48-hour window, including a scheduled daily job. Confirm each runs once on the configured model/timeout with the expected notify/retry behavior and reaches PTY. Compare job results, spawn PIDs and timestamps; no -p process may serve an agent or cron turn.
5. Dispatch an agent job. Confirm the worker starts on PTY, completes, and its result reaches the dispatcher once through agent-job:<id>. Inspect cron/job receipt delivery_outcome=turn-started and investigate any unconfirmed-idle, unconfirmed-live or stuck-compaction result.
6. Exercise a non-channel CLI/REST or heartbeat prompt on the bus. Confirm pty-stdin supervision and delivery confirmation. Check there are no duplicate prompt submissions or missing replies.
7. At approximately hour 24, restart the daemon. Recheck startup engines and PIDs, session continuity and newly due jobs. Repeat fresh chat after restart; confirm no lingering old writer owns the same transcript.
8. Run /compact on a live session, then another chat and a job. Verify the #549 live-session flow, preserved context and successful post-compaction turn; no print process may serve the agent retry. Deliberate trusted utility fallback is recorded separately.
9. Throughout the window, correlate process samples with spawn/turn logs. Record all timeouts, retries, unexpected exits, dropped/duplicate deliveries, rate-limit fallbacks and tool/MCP failures. Utility print calls must be distinguishable from agent turns and cron jobs using the inventory above.
10. At or after hour 48, record UTC end time, workload counts, restart/compaction evidence and failures. A pass requires the stated workload, no print agent/cron processes and no unresolved correctness failures. Attach the result summary to the coordinator's PR before rollout.
11. If the soak fails, retain the evidence, keep rollout blocked, set pty.enabled=false and the appropriate per-agent process-stream-json overrides, restart, and verify the fallback startup summary and processes.

## Review, prior art and handoff

Reviewed the diff for isolation and session-store boundaries: no critical or high security issue found. Recovery preserves model/API/security/system context and selects the fallback store when appropriate. No credential values, user prompts or environment dumps were added to startup logging.

No Ultra code was reused; the provided prior-art check found the same defaultSupervisionFor and no alternative implementation needed for this default change. README.md was not edited; the coordinator should add the migration-guide link and new defaults after #558 merges. No PR, merge or GitHub comment was created. The unrelated untracked #559 investigation SPEC and local memory/Serena scaffolding are excluded from task commits.

## Review-fix pass — task_016cc3fe4f34

This section supersedes the initial report where behavior changed. Applied the supplied Opus review (no CRITICAL/HIGH findings) as additional work on top of 451c9359, without rewriting branch history.

### Fixes and evidence

- M1: exhausted final PtyTurnTimeoutError now produces exit 124; unrelated errors remain exit 1. The compact fixture delegates to the real supervisor with a PTY double throwing the real timeout error, rather than fabricating a supervisor 124 result. Runner retirement and disposal precede the precompact memory-save and compact print utilities, eliminating the concurrent transcript writer. Its ordinary postcompact recovery retirement remains idempotent.
- Corrupted-session recovery now recognizes a line beginning API Error containing the thinking signature error even when the REPL returns exit 0. Primary and fallback-session paths both reset and retire their own stores/process keys. Tests use HTTP400 JSON with backticks around signature and thinking. This is executable PTY recovery, not a print-only exception; ordinary signature prose without the API-error line is not newly treated as failure.
- M2: normal startup schedules bootstrap in the background, logs success/failure, and proceeds to preflight, hot reload and job wiring. Bootstrap synchronously reserves the global runner queue before asynchronous session lookup, preserving context ordering with later global chat. It gets one turn attempt, no supervisor retries/respawns or rate-limit fallback, and a turn deadline of min(configured timeout, 30 seconds). Supervisor admission/serialization stages retain their existing individual deadlines; this is not a claim that every stage shares one total 30-second wall-clock budget. A never-settling bootstrap cannot block the next startup step, proved with a 40ms rejection bound. The runner fixture also proves the single timed-out attempt releases a later queued chat.
- M3/M4: recovery uses config.model || modelOverride, matching primary model choice; PTY rate-limit fallback forwards both chunk and tool-event callbacks.
- M5: invalid pty.enabled warnings are deduplicated for each distinct JSON value for the life of the process, including repeated reloads. The bad value itself is never logged.
- M6: migration guidance now states runner engine flips apply after the approximately 30-second settings reload; bus-agent supervision/runtime changes require restart. It narrows the origin fallback change to agents spawned without resolver-selected supervision, since resolved declared agents already defaulted to PTY.
- M7: startup logging is exercised through the actual logger helper called by start, replacing source-string inspection. Removed the bootstrap source prohibition covered by routing behavior. Added actual SessionManager.spawnAgent cron selection with no declared supervision, alongside the explicit print control.
- Both bump scripts ran twice, moving plugin and marketplace plugin entries from 2.2.337 through 2.2.338 to 2.2.339; merging main (2.2.340) and a further bump took the branch to **2.2.341**. Read-back asserted both equal 2.2.341.

### Final review validation

Tests ran with Bun directly, using absolute test paths and --preload <repo>/scripts/test-preload.ts in isolated temporary working directories with a src symlink. This protects state from the known routing/supervisor test cleanup behavior. No test output was piped into head/tail.

| Scope | Result |
| --- | --- |
| bun test pty-config, pty-default-runner, startup-initialization, execution-engines and job-loop | 114 pass, 0 fail |
| bun test pty-supervisor | 78 pass, 0 fail |
| bun test pty-integration, pty-enabled-routing and pty-backward-compat | 34 pass, 0 fail |
| bun test bus agent-resolver, pty-default-delivery, wiring and scheduler-wiring | 34 pass, 0 fail |
| bun test bus session-manager --test-name-pattern 'without declared supervision\|explicit process-stream-json' | 2 pass, 0 fail |
| Total scoped final tests | **262 pass, 0 fail** |
| bun run lint --reporter=json, whole repository | exit 0; 0 errors, 1235 advisory warnings, 323 informational diagnostics |
| bun run typecheck, repository ratchet | exit 0; 149 diagnostics, baseline 149, unchanged |
| git diff --check | clean |

Before implementing the review fixes, the new timeout test returned 1 instead of 124, the actual compact test showed retirement after utility invocation, rendered-error tests did not recover, model override was empty, callbacks were absent, and four reloads warned four times instead of twice. The new startup test initially failed to import the not-yet-created module. After implementation, **14 single-site fault injections** independently made the tests below go RED; each injection was reverted in a finally block before proceeding. All final results above were obtained after restoring the production code.

### timeout-status

```text
(fail) pty-supervisor retry and backoff > returns 124 when its final turn failure is a timeout [80.67ms]
```

### no-retries

```text
(fail) pty-supervisor retry and backoff > retry false permits exactly one turn and no respawn despite global retry settings [17.80ms]
```

### retire-before-utility

```text
(fail) #550 default runner routing > retires the actual timed-out PTY before memory save or compact can resume it [366.77ms]
```

### rendered-primary

```text
(fail) #550 default runner routing > recovers signature errors rendered by a PTY that returned exit zero [270.71ms]
```

### rendered-fallback

```text
(fail) #550 default runner routing > recovers a signature error rendered by the fallback PTY [269.26ms]
```

### recovery-model

```text
(fail) #550 default runner routing > keeps the model override when retrying a fallback whose configured model is empty [941.94ms]
```

### fallback-chunks

```text
(fail) #550 default runner routing > streams chunk and tool events during a rate-limit fallback [164.91ms]
```

### fallback-tools

```text
(fail) #550 default runner routing > streams chunk and tool events during a rate-limit fallback [159.94ms]
```

### dedup-warning

```text
(fail) parseSettings — pty defaults > warns once per distinct invalid enabled value across reloads [43.36ms]
```

### background-bootstrap

```text
(fail) background startup initialization > a never-completing bootstrap does not delay the next startup step [46.04ms]
```

### bootstrap-one-attempt

```text
(fail) #550 default runner routing > bootstrap reserves the queue, uses one bounded attempt, and releases a later chat [501.80ms]
```

### bootstrap-deadline

```text
(fail) #550 default runner routing > bootstrap reserves the queue, uses one bounded attempt, and releases a later chat [1881.51ms]
```

### startup-log

```text
(fail) #550 startup engine summary > startup actually emits the summary [16.49ms]
```

### spawn-origin-default

```text
(fail) pty-stdin supervision > spawnAgent selects PTY for cron without declared supervision [291.71ms]
```

### Remaining scope and manual checks

No requested review fix remains undone. README.md and issue #559 were not changed. No new Ultra code was reused: this pass adapts the existing Plus supervisor and runner rather than copying the diverged Ultra runner. The original remaining-print inventory and exact 48-hour operator soak checklist above remain applicable; trusted utility calls still await #549 integration. No live Claude or production-daemon verification was performed in this pass, and no fix for #559 is claimed. Keep the independent #559 and #548/#549 integration checks and the operator soak as rollout gates.

Security review of this follow-up found no CRITICAL/HIGH issue: retirement respects session keys, recovery separates primary/fallback stores, and logging adds no prompt, credential or environment values. Local memory checkpoint was appended by the memory worker; Graphiti ingestion was queued but not confirmed by immediate read-back.

## PR 562 Codex fallback-stream finding — task_d6cfe1f8b211

Fixed duplicate dashboard fallback replies. PTY fallback chunks were forwarded to the dashboard, then streamClaude unconditionally emitted the complete fallback stdout again because usedFallback was true. RunResult now tracks fallbackStreamedText independently of primary text; only a fallback that emitted no nonempty text gets its buffered stdout emitted at completion. Tracking resets for each fallback/recovery attempt. Empty chunks do not count as text. Non-streaming stdout and legacy print execution are unchanged.

The new isolated fixture drives the actual streamUserMessage("chat") path: its primary PTY streams a rate-limit notice, then its fallback PTY streams two reply chunks or emits only an empty chunk. The streamed-answer test failed before implementation:

```text
(fail) #550 default runner routing > dashboard emits a PTY fallback reply exactly once when it streams chunks [255.89ms]
```

Two independent single-site mutations of the final-emission decision proved both guards; each mutation was restored in a finally block before final validation:

1. Force final stdout emission despite streamed fallback chunks:

```text
(fail) #550 default runner routing > dashboard emits a PTY fallback reply exactly once when it streams chunks [148.10ms]
```

2. Suppress final stdout emission for a silent fallback after the primary notice:

```text
(fail) #550 default runner routing > dashboard emits silent fallback stdout once after the primary streamed its notice [288.89ms]
```

Final validation used Bun with --preload <repo>/scripts/test-preload.ts and absolute test paths in isolated temporary working directories with a src symlink. No runner output was piped into head/tail and no full suite was run.

| Command/scope | Result |
| --- | --- |
| bun test runner.test.ts pty-default-runner.test.ts | 50 pass, 0 fail |
| bun test pty-enabled-routing.test.ts pty-backward-compat.test.ts | 26 pass, 0 fail; includes PTY and legacy print fallback controls |
| Total | **76 pass, 0 fail** |
| bun run lint --reporter=json over whole repository | exit 0, 0 errors, 1235 warnings, 323 informational diagnostics |
| bun run typecheck ratchet | exit 0, 149 diagnostics against baseline 149, unchanged |
| git diff --check | clean |

No requested fix remains undone. Version 2.2.341 is deliberately unchanged under the explicit no-bump dispatch instruction. No new Ultra code was reused. No live Claude, browser or production SSE check was performed; dashboard delivery is proved at its runner stream callback boundary. README and issue 559 remain untouched, existing external integration/operator soak gates remain applicable, and no GitHub comment or thread resolution was posted.
