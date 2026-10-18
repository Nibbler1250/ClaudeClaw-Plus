# Issue #550 implementation report

Implemented on `feat/550-pty-default` from `povai/main` at `d81bd579`. The testable requirements are implemented. Merge and rollout remain blocked on the independently owned #559 fix, the #548/#549 utility dependencies, and the operator's 48-hour soak. README.md is deliberately untouched because PR #558 owns its rewrite.

## Changes

- DEFAULT_SETTINGS.pty.enabled is true, including freshly generated settings. Missing values default true; literal false is preserved; invalid enabled values warn without logging the supplied value.
- defaultSupervisionFor selects pty-stdin for every BusOrigin (discord, telegram, slack, webui, cron, heartbeat, cli, rest). Explicit agent supervision, including process-stream-json, remains authoritative.
- Bootstrap now follows the same configured engine as other agent turns. Primary-corruption, stale-session and post-compaction retries route through a shared recovery helper. PTY recovery retires the old process before reading the reset session store or resuming the compacted transcript. Explicit print recovery remains supported and tested.
- Startup emits the effective runner-turn, cron-job and bus non-channel default engines, plus every declared agent's supervision override.
- docs/pty-migration.md explains upgrade behavior, both print opt-outs, restart requirements and startup/spawn/process verification. The job-loop comment and warning now accurately describe the configured engine.
- Print-specific bus fixtures explicitly request process-stream-json. Existing runner default/bootstrap assertions were updated. The #559 restoreDir defect was not changed; its routing suite was run in an isolated temporary cwd to protect developer state.
- Both plugin manifests were bumped with the prescribed scripts to 2.2.337.

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
| both version bump scripts | 2.2.337 |

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
