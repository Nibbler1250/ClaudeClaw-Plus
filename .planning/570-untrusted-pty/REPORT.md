# #570 interactive isolation spike

Branch: `feat/570-untrusted-pty-isolation`, stacked on `7ad148409ce6e700778bdd73e2b0a046eca6aca4` (#575).

## Changes and decisions

Followed brief v2 and its addendum. The cancelled HTTP draft is preserved in stashes named `570 option B draft` and `570 option B draft tests`. Added a disposable-CI-only real-Claude suite with six property groups (transcript cleanup has an independent pair), captures of the supervisor's actual argv, and control-removed twins whose baseline assertions must fail. No real model calls or credentials were used locally.

Added cleanup of the unique temporary cwd's external Claude project transcript directory after PTY retirement. `--no-session-persistence` remains in the shared constant for parity, but is documented print-only by installed Claude **2.1.304**. Cleanup failure propagates; unrelated project transcripts are preserved. The unit test drives `runOnceOnPty` and captures its actual spawn options. The existing registry-wide argv contract already covers both CLI engines and remains intact.

PTY still advertises `caps.isolation: false`, and implicit untrusted routing still selects print. No README or engine-default change is permitted before live evidence. HTTP engines remain explicit opt-in.

## Local verification

- `env -u ANTHROPIC_BASE_URL bun test src/oneshot src/__tests__/session-actions-argv.test.ts`: **171 pass, 4 skip, 0 fail**.
- `bun test src/__tests__/pty-process.test.ts src/__tests__/pty-supervisor.test.ts src/__tests__/pty-supervisor-mcp.test.ts`: **161 pass, 0 fail**.
- Integration file run from `tests/integration` locally: guarded suite skipped; no canaries or authentication attempted. After adding an independent transcript pair the suite contains 14 live tests, not part of the default unit suite.
- Whole-repo `bun run lint`: exit 0, **0 errors, 1301 warnings, 324 infos**.
- `bun run typecheck`: exit 0, **149 errors against baseline 149**, no regression.
- Both version scripts: plugin and marketplace **2.2.345**.

## Fault injection evidence

One site at a time, each restored before the green run. Initial new test failed because its cleanup module did not exist. The meaningful mutation checks were:

Dropping only `--disable-slash-commands` from the PTY argv:

```text
(fail) the actual untrusted PTY spawn preserves the complete shared isolation argv [31.70ms]
```

Disabling only transcript removal:

```text
(fail) removes external transcripts and the empty cwd after success [5.65ms]
(fail) removes external transcripts and the empty cwd after failure [2.08ms]
```

Restored `pty-process.ts` has no diff; restored unit run: **3 pass, 0 fail, 13 assertions**. No injected faults remain.

## CI evidence

First run: [39345281267](https://github.com/TerrysPOV/ClaudeClaw-Plus/actions/runs/39345281267), `d6523f2eedb056954f91061f535454ea1f17f9e0`, Claude **2.1.304**. **7 existing tests passed, 14 new tests failed**, all on the setup guard (expected exit 0, received 1) before the property check. No unrelated integration tests failed. Neither direction established isolation or leakage.

Second and final authorized run: [39345585640](https://github.com/TerrysPOV/ClaudeClaw-Plus/actions/runs/39345585640), `5ec2e5da76bdcc46eb29369ff5ebad2ddc8814c0`, Claude **2.1.304**. Added sanitized startup-error classification and an assistant-transcript setup guard, so a user prompt echoed by the TUI cannot pass readiness. **7 existing tests passed, 14 new tests failed**. All fourteen captured spawn errors classified as:

```text
[isolation-spike] startup rejection: printOnlyPersistence=true; auth=false
```

The interactive CLI rejects `--no-session-persistence` before the first turn. No property assertion or its twin was reached. This is a startup failure, not proof that any canary leaked or was isolated. The two runs consumed no successful spike model turns; the existing integration tests used their normal quota. No unrelated failures were found, and no further workflow was dispatched.

| Property / control | Baseline result | RED with control removed |
| --- | --- | --- |
| Tools / `--tools ""` | Blocked, rc 1 | Unmeasured: same startup rejection |
| MCP / `--strict-mcp-config` | Blocked, rc 1 | Unmeasured: same startup rejection |
| Hooks / `--setting-sources ""` | Blocked, rc 1 | Unmeasured: same startup rejection |
| Memory / source restriction + empty cwd | Blocked, rc 1 | Unmeasured: same startup rejection |
| Commands / disable flag + slash guard | Blocked, rc 1 | Unmeasured: same startup rejection |
| Cwd/transcript / unique temp dir + finally cleanup | Empty cwd verified before spawn; live transcript absent | Unmeasured; no real transcript to retain |
| Environment / caller's classifier policy | Child-environment readback not reached | Unmeasured: same startup rejection |

Actual captured argv (all shared flags present, including empty values):

```json
["--model","haiku","--tools","","--strict-mcp-config","--setting-sources","","--no-session-persistence","--disable-slash-commands"]
```

Authentication uses only the existing workflow's step-scoped secret environment. Raw screens, transcripts and environment contents are never emitted by the new suite. Negative controls report caught assertion failures as `RED-with-control-removed` lines only if they reach their property assertion.

## Scope and remaining work

Stopped at the red spike as instructed. No measured leak can be claimed, and interactive isolation remains unproved. Exact shared argv parity currently conflicts with successful interactive startup because the CLI rejects a shared print-only flag. The new cleanup compensates for transcript persistence only once the PTY can boot; simulated unit files prove its local behavior, not the live security property. Source inspection also identifies a possible caller-environment policy gap, which remains unmeasured.

Step 3 is deliberately deferred: no capability flip, untrusted default change, default-to-print mutation probe, README edit or public engine-guide claim. The Claude security review remains for the coordinator before any PR. No prior-art code copied; existing shared argv and supervisor seams reused. `.planning/559-pty-submit/`, `.serena/`, scratchpads and other pre-existing untracked state remain untouched. The cancelled option B draft is still stashed.

## r3 continuation

The coordinator explicitly authorized continuing past the startup blocker. Added the single print-only subset and derived interactive argv; no critical isolation flag is omitted. Local help/version check (no auth) on 2.1.304 confirmed the other four flags have no print-only restriction. The transcript cleanup remains the explicit persistence compensation.

Fixed the confirmed caller-environment policy gap: untrusted PTY uses print's async-local override or the same clean default, without trusted provider augmentation. Its native FFI spawn applies that exact key policy to both JS and libc environments, including native-only keys, and restores each snapshot separately. Trusted strip-list semantics remain intact. Unit tests capture the caller policy and use a real harmless shell PTY with a native-only canary to prove no inheritance and restoration after success/throw; no local Claude model/auth calls.

Single-site fault probes, all restored:

```text
(fail) the actual untrusted PTY spawn preserves every interactive isolation argument [29.76ms]
(fail) the print-only exception is exactly the explicit compensated persistence flag [2.56ms]
(fail) untrusted PTY spawn uses the exact same caller environment policy as print [23.25ms]
(fail) untrusted native PTY inheritance excludes even native-only variables and restores the parent [33.12ms]
```

The faults respectively removed strict MCP isolation, added tools to the print-only subset, bypassed the caller override, and bypassed the native policy at the FFI boundary. Environment comparisons emit only booleans on failure. No injected fault remains.

Local required one-shot/session checks: **174 pass, 4 skip, 0 fail**. Runner/PTY checks (including `runner.test.ts`): **193 pass, 0 fail**. Whole-repo lint: **0 errors, 1302 warnings, 324 infos**. Typecheck ratchet **149 against baseline 149**. Both version scripts produced **2.2.346**. Live workflow results pending below.

r3 run 1 dispatched: [39347652032](https://github.com/TerrysPOV/ClaudeClaw-Plus/actions/runs/39347652032), commit `d1c12fd4`.

During the wait, an additional unit check found that caller environment overrides can also change the transcript root. Cleanup now derives its root from that caller policy (CLAUDE_CONFIG_DIR, then HOME), matching the actual child. Before the fix:

```text
(fail) transcript cleanup follows the caller's Claude config directory override [14.69ms]
```

After this correction the required scoped suite reports **175 pass, 4 skip, 0 fail**. One preceding run had the existing HTTP stalled-body timeout test return 1 instead of 124 in 3.64ms; it runs before the new PTY tests and passed on the unchanged rerun. No unrelated test code was changed. Lint and typecheck remain at the same passing counts. The live run above uses matching parent/caller config roots, so this additional override case is unit-only evidence.

### r3 workflow outcome and stopping point

[Run 39347652032](https://github.com/TerrysPOV/ClaudeClaw-Plus/actions/runs/39347652032), full tested SHA `d1c12fd49081c3768c11e7e1795b8a3c7dddc7c1`, Claude **2.1.304**: **17 pass, 4 fail**. Seven existing tests passed; new suite **10 pass, 4 fail**. Startup works with the explicitly derived interactive arguments. Follow-up `ffb4ec255e44bf0cff3e569455e8a7be9b19210a` aligns transcript cleanup with caller config roots and is covered by the local regression, not a separate live run.

| Property | Control present | Control removed / RED evidence |
| --- | --- | --- |
| Tools | rc 0 and actual transcript, but missing completion token blocked the property assertion | Valid RED predicate: tool marker or tool_use detected |
| MCP | No stub marker | No stub marker either; twin failed, no valid RED |
| Hooks/settings | No hook marker | Valid RED predicate: hook marker fired |
| User memory | No memory canary | No canary either; twin failed, no valid RED |
| Commands/cwd | No command canary; empty cwd observed and removed | Twin failed; allowReplCommand only allows /compact, so arbitrary command never bypassed the input guard |
| Transcript cleanup | Real JSONL seen before finally; removed afterwards | Valid RED predicate: disabling cleanup leaves JSONL |
| Environment | Actual child fake canary absent | Valid RED predicate: admitted fake canary present |

Caught real-control assertion failures logged verbatim:

```text
[isolation-spike] RED-with-control-removed tools: expected true, received false
[isolation-spike] RED-with-control-removed hooks: expected true, received false
[isolation-spike] RED-with-control-removed transcript cleanup: expected true, received false
[isolation-spike] RED-with-control-removed environment: expected true, received false
```

No baseline leak was observed. Tools baseline is inconclusive because its wording guard failed despite a completed turn. MCP/memory fixture discovery and their ineffective twins remain undiagnosed; absent canaries in both directions are not isolation evidence. The command twin did not remove the existing /compact-only guard, as confirmed in the sanitizer source; no production guard was weakened to make it pass. These limitations are exposed as failing tests, not hidden skips or passing claims.

**Stopped without Step 3:** all six properties and every twin were not proved. No new startup blocker occurred, so the brief's conditional startup retry was not used. No further workflow dispatch, capability flip, untrusted default change, rollout docs/README change or PR. Production keeps PTY isolation false and untrusted routes on print; HTTP stays explicit opt-in. Plugin and marketplace remain **2.2.346**. The remaining work is probe-fixture/negative-control diagnosis under a subsequent authorization, followed by security review before any PR.

## r4: authorized fixture diagnosis

Added a first positive-control spawn with plain interactive argv (`--model haiku` only) and the same planted child HOME/config. It requires MCP startup, hook execution and a memory-derived answer, logs each nonsecret boolean even if readiness fails, and blocks subsequent live rows if the fixtures are not proved. Both the supplied child environment and `/proc/<pid>/environ` must resolve to the fixture root; only this shape is logged: `[RUNNER_TEMP]/untrusted-pty-<random>/home/.claude`, with `.claude.json` for MCP and `CLAUDE.md` for memory. The fixture policy binds HOME explicitly instead of relying on runtime-cached homedir().

The MCP stub implements initialize/tools/list/tools/call and responds over JSON-RPC. Tests request its harmless probe tool and wait up to 15 seconds for asynchronous startup. Memory is now a specific passphrase question whose value occurs only in the planted memory file, and the memory row disallows tool activity. MCP/memory twins remove the complete argv isolation policy to account for overlapping discovery controls; these prove the aggregate policy rather than attributing behavior uniquely to a single flag.

Tools readiness now requires a real nonsynthetic assistant transcript entry, independent of wording. The command flag is tested with source discoverability held equal in both directions and the input sanitizer bypassed through `_preparePromptForWriteForTests`, an internal spawn-only callback not exposed through settings or OneShotRequest. Its production default still uses the original sanitizer. The existing sanitizer contracts continue to run unchanged. No production guard was weakened to make a twin red.

New seam fault injection (single constructor assignment disabled; restored afterwards):

```text
(fail) the internal prompt-write test seam reaches the wire without changing the default sanitizer [134.07ms]
```

Local required checks: **176 pass, 4 skip, 0 fail**; runner/PTY **193 pass, 0 fail**; local integration safety guard **0 pass, 16 skip, 0 fail** (including Bun's unnamed skipped hook); whole-repo lint **0 errors, 1302 warnings, 324 infos**; typecheck **149 against baseline 149**. Plugin and marketplace bumped to **2.2.347**. Live diagnosis/confirmation results follow below.

### r4 diagnosis run

[39350018215](https://github.com/TerrysPOV/ClaudeClaw-Plus/actions/runs/39350018215), `e6f93193`, Claude **2.1.304**: **20 pass, 2 fail** (22 tests, 3 files). The child config root resolved to `[RUNNER_TEMP]/untrusted-pty-<random>/home/.claude` (MCP in `.claude.json`, memory in `CLAUDE.md`), matching the planted fixtures.

**Positive control (plain interactive, no isolation flags):** `MCP=true; hooks=true; memory=true; assistant=true; completed=true`. All three canaries fire, so the fixtures are discoverable.

| Property | Control present | Control removed |
| --- | --- | --- |
| Tools | **FAIL (fixture)**: turn exit 0, but no non-synthetic assistant entry read from the transcript | Valid RED (`expected true, received false`) |
| MCP | isolated=true | Valid RED |
| Hooks/settings | isolated=true | Valid RED |
| User memory | isolated=true | Valid RED |
| Command flag alone (sanitizer bypassed in tests) | **FAIL (fixture)**: exit 124 after 120 s | Valid RED: with the flag removed the command ran and the canary appeared |
| Transcript cleanup | isolated=true | Valid RED |
| Environment | isolated=true (fake env canary absent in actual child) | Valid RED (canary admitted, present) |

No baseline leak. Both failures are fixture/readiness problems, not property failures:

- **Command flag baseline:** with `--disable-slash-commands` the slash command is most likely refused locally and never reaches the API, so no turn completes and the PTY idles out (124). That would be the flag working, but the harness required exit 0. This explanation is inferred, not observed: the log carries no screen. The twin proves the fixture is discoverable (it ran the command).
- **Tools baseline:** PTY turn completion is detected from the screen, and the transcript can lag it (`confirmRenderedSignatureError` retries for the same reason). The harness read the transcript once, immediately. Also inferred, not proven: a refusal or other synthetic assistant entry cannot be excluded from this log alone, so the fix also logs structural diagnostics.

RED lines, verbatim from the run:

```text
[isolation-spike] RED-with-control-removed tools: expected true, received false
[isolation-spike] RED-with-control-removed MCP: expected true, received false
[isolation-spike] RED-with-control-removed hooks: expected true, received false
[isolation-spike] RED-with-control-removed memory: expected true, received false
[isolation-spike] RED-with-control-removed command flag alone (not production sanitizer): expected true, received false
[isolation-spike] RED-with-control-removed transcript cleanup: expected true, received false
[isolation-spike] RED-with-control-removed environment: expected true, received false
```

### r4 fixture fixes (test file only, no production guard touched)

- Transcript evidence is collected in a `finally` around the turn, polling up to 15 s for a non-synthetic assistant entry, then settling 500 ms and re-reading. If none appears it logs type names, counts, stop reasons and block types only, never content.
- The command-flag baseline runs with a 30 s bound and accepts exit 0 or 124 (no API turn expected), asserting the canary is absent. The twin keeps the strict path: exit 0 and a real assistant entry, so it still has to execute the command to go RED.
- Local: guard suite **0 pass, 16 skip, 0 fail**; lint 0 errors; no type errors in the changed file. Plugin and marketplace bumped to **2.2.348**.
