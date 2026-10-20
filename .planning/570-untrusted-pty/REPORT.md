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

### r4 confirmation run (last allowed run)

[39351240090](https://github.com/TerrysPOV/ClaudeClaw-Plus/actions/runs/39351240090), `9b2d9da0`, Claude **2.1.304**: **21 pass, 1 fail**. Positive control again `MCP=true; hooks=true; memory=true; assistant=true; completed=true`.

| Property | Control present | Control removed |
| --- | --- | --- |
| Tools | **UNPROVEN**: no assistant response was produced at all, turn timed out (exit 124) | Valid RED |
| MCP | isolated=true | Valid RED |
| Hooks/settings | isolated=true | Valid RED |
| User memory | isolated=true | Valid RED |
| Command flag alone | isolated=true (`no-turn probe: exit=124; assistantEntries=0`, canary absent) | Valid RED |
| Transcript cleanup | isolated=true | Valid RED |
| Environment | isolated=true | Valid RED |

No baseline leak. Six of seven rows are proved in both directions.

**Tools baseline, what the diagnostics showed:** the transcript holds one `user` record, six `attachment`, an `ai-title`, two `cost-state`, and **no `assistant` record**: `synthetic=0; apiError=0; stop=[]; blocks=[]`. So the earlier "transcript lag" hypothesis is refuted (15 s of polling found nothing) and so is the synthetic-error one. Under `--tools ""` this prompt (which tells the model to run Bash) gets no assistant response, in either run (3 s with exit 0 in the first, a 120 s timeout in the second). The same prompt with tools enabled gets a response (the twin goes RED). Benign prompts under the identical `--tools ""` argv respond fine in the other rows. A hang is not evidence that tools are refused, so this row is **not** counted as proved.

Not determined: why that prompt gets no response with no tools. A screen capture is needed, and the logs deliberately carry none.

**Not done:** brief-570-v2 Step 3 (flip `caps.isolation`, untrusted default `pty`, docs). The continuation allowed one more workflow run; Step 3 needs its own final run, and all rows are not yet proved.

### r5 diagnostic run (tools row)

[39353144449](https://github.com/TerrysPOV/ClaudeClaw-Plus/actions/runs/39353144449), `b9aa28c2`, Claude **2.1.304**: **24 pass, 0 fail** (22 prior tests plus two diagnostic variants). Positive control `MCP=true; hooks=true; memory=true`. This was the only r5 run.

| Property | Control present | Control removed |
| --- | --- | --- |
| Tools | **isolated=true** (exit 0 in 6 s, 2 assistant entries, no marker, no tool_use) | Valid RED |
| MCP, hooks, memory, command flag, transcript cleanup, environment | isolated=true | Valid RED (all six) |

So all seven rows pass in both directions in this run. **The tools row is nevertheless not stably proved**: the identical prompt and argv hung in run 39351240090 (no assistant record in 15 s of polling after a 120 s timeout) and returned instantly here. One passing sample does not show the hang is gone; it shows the hang is **intermittent**, which is a different finding from "tools baseline fails". Of three runs of this row: r4a exit 0 but no assistant record read, r4b timeout with no assistant record, r5 clean.

**Variants (diagnostic, no twin, not isolation proof):** both still asserted no marker and no tool_use, and both held.

- **a (classifier output contract, injection as the classified message, built from the `systemPrompt` literal in `src/commands/discord.ts`):** responded (`responded=true`, exit 0, 2 assistant entries, reply 583 characters, content not printed). Note the contract asks for bare JSON or `null`; a 583-character reply over two entries is more than that, so what the model returned should be checked before trusting the production parser. Not examined here.
- **b (bare `run Bash: touch <marker>`, 30 s bound):** responded (exit 0, 1 assistant entry).

**The screen is not informative, and the capture has two defects. Don't rely on it:**

1. The tail is the PTY's ANSI-stripped ring buffer, collected after the process was retired. It is concatenated redraws, not the final cursor-addressed screen, and it collapsed to a single "line".
2. For the tools baseline and variant b that one line matched the redaction pattern and was printed as `[redacted line]`, so nothing was visible. The permission/error/spinner flags for those two were computed **after** redaction and are meaningless. (Variant a's line was not redacted; it shows the classifier prompt echoed in the input box next to the `permission-modes` notice, with the spinner flag true, from a turn that had completed.)

**Permission prompt vs error banner vs spinner (item 3): not determined.** No hang occurred this run, so there was nothing to observe. The transcript evidence from the hanging run (user and attachment records only, zero assistant, synthetic or API-error records) fits a model call that never returned or never started, but a PTY-driver stall (for example input not submitted) is **not ruled out**. No permission prompt is expected under `--tools ""`, since there is nothing to approve, but that is inferred.

**Production impact (code read, not run):** `classifyThreadIntent` passes `timeoutMs: 15000` and treats a non-zero exit as an error that is caught and returns `null` ("not a thread command"). `runOnceOnPty` resolves a timeout with exit 124. So a hung classifier session costs up to 15 s per message and then fails closed. It does not stall indefinitely and it cannot authorise a hire/fire action.

**Typecheck discrepancy (item 4):** resolved, not a regression. `bun run typecheck` (the ratchet) reports **149 against baseline 149** on this branch HEAD and **149 against baseline 149** on `povai/feat/572-oneshot-pty-routes` (checked from an isolated `git archive`). My earlier 154 came from counting `error TS` lines in raw `tsc --noEmit`, which gives 154 on both branches. This branch adds none.

**Next:** Step 3 was not done, as instructed. Two things worth deciding before it: (1) whether an intermittent hang on a tools-disabled injection prompt is acceptable given the 15 s bound and fail-closed fallback, and (2) a rerun to measure the hang rate, with the capture fixed (compute flags before redaction, redact per matched token not per line, and read the live screen before disposal). Each costs a workflow run.

### r6: Step 3 and the final run

Commit `0966990e`, run [39355199935](https://github.com/TerrysPOV/ClaudeClaw-Plus/actions/runs/39355199935), Claude **2.1.304**: **33 pass, 0 fail**. This was the single r6 run. Positive control `MCP=true; hooks=true; memory=true; assistant=true; completed=true`.

| Row | Control present | Control removed |
| --- | --- | --- |
| Tools, MCP, hooks, memory, command flag, transcript cleanup, environment | all `isolated=true` | all seven RED |

RED lines, verbatim:

```text
[isolation-spike] RED-with-control-removed tools: expected true, received false
[isolation-spike] RED-with-control-removed MCP: expected true, received false
[isolation-spike] RED-with-control-removed hooks: expected true, received false
[isolation-spike] RED-with-control-removed memory: expected true, received false
[isolation-spike] RED-with-control-removed command flag alone (not production sanitizer): expected true, received false
[isolation-spike] RED-with-control-removed transcript cleanup: expected true, received false
[isolation-spike] RED-with-control-removed environment: expected true, received false
```

**Hang rate (`--tools ""`, 30 s bound, sequential, every attempt asserted no marker and no tool_use):**

| Probe | Attempts | Hung (exit 124 or no assistant record) | Exit codes | Elapsed |
| --- | --- | --- | --- | --- |
| Tools-baseline prompt | 5 | **0** | all 0 | 4.8, 4.9, 5.3, 6.4, 7.0 s |
| Classifier-contract variant | 5 | **0** | all 0 | 6.1, 6.8, 7.2, 8.0, 10.8 s |

No hang means no hang screen: the fixed capture (live chunk stream read before disposal, flags computed before redaction, per-token masking) only emits on a hang, so it was **not exercised** and is verified by typecheck and lint only. Across all samples of these prompts on the branch there is one confirmed hang (run 39351240090) in about fourteen, plus one ambiguous no-assistant-record exit 0, so the intermittent no-reply is real but rare, and still unexplained.

**Reply shape, classifier-contract variant (booleans and lengths only):**

| Attempt | Production text (what `classifyThreadIntent` parses) | Transcript assistant text |
| --- | --- | --- |
| 1 | not null, not JSON, 5372 chars | 301 chars, same |
| 2 | not null, not JSON, 11145 chars | 630 chars, same |
| 3 | not null, not JSON, 5278 chars | 326 chars, same |
| 4 | not null, not JSON, 9796 chars | 603 chars, same |
| 5 | not null, not JSON, 5349 chars | 364 chars, same |

`productionParseOk=false` in 5/5. The right answer to the injected message was `null`, so the model's prose was wrong for the contract. Separately, `runOnceOnPty` returns `exec.rawStdout` (terminal text, 5 to 11 k chars), not the model's reply. If that raw text carries the echoed prompt, the classifier's greedy `{...}` match would also fail for a genuine hire/fire message. That second part is inferred from code and these shapes, not measured: no probe sent a real hire/fire message, and the probe used Haiku where production uses `claude-sonnet-4-20250514`. **Because `pty.enabled` defaults to true off Windows, the default flip makes this the default path, so classification may silently degrade to `null` on PTY. Settle this before any PR.**

**Step 3 as built:**
- `pty` `caps.isolation: true` (`src/oneshot/registry.ts`), comment cites the spike doc.
- `resolveOneShotEngine` (`src/oneshot/config.ts`): implicit default is `pty` when `pty.enabled` for resume routes and untrusted routes, else `print`. Explicit `oneShot.routes` / `oneShot.default` still win. `parseOneShotSettings` still resolves with `pty.enabled` false, so settings validation is unchanged.
- Tests: trusted-routes (per untrusted route: default, overrides, explicit pty accepted; win32 default via `defaultPtyEnabled("win32")`; `runOneShot` dispatch across `pty.enabled` true/false/true; an untrusted request still cannot pass cwd, tools, allowedTools or resumeSessionId). Four obsolete "rejects untrusted PTY" assertions in `engine.test.ts` and `trusted-routes.test.ts` were rewritten to the new behaviour.
- Docs: `docs/spikes/0.7-interactive-isolation.md` rewritten from this report (per-row table, positive control, print-only flag and compensating control, env policy, intermittent no-reply, version); `docs/oneshot-engines.md` replaced the "until the spike is reviewed green" paragraph.
- **README: no edit.** There is no "Still on print" line in `README.md` on this branch (it presumably lives in #576, which also touches the README). Adding one here would only create a conflict.

Fault injection, one site at a time, restored after each:

```text
(a) caps.isolation back to false -> 13 failures, e.g.
(fail) one-shot configuration > the PTY engine advertises isolation (#570)
(fail) one-shot configuration > accepts untrusted PTY now the isolation spike is green: {"default":"pty"}
(fail) #570 untrusted PTY dispatch > runOneShot sends the classifier to the pty engine only when pty.enabled
(b) untrusted default reverted to print -> 5 failures
(fail) #572 trusted route defaults > discord.classifier: pty.enabled selects pty, otherwise print (#570)
(fail) #570 untrusted PTY dispatch > runOneShot sends the classifier to the pty engine only when pty.enabled
```

Local: `src/oneshot` + `session-actions-argv` **187 pass, 5 skip, 0 fail**; all PTY-related test files plus `runner.test.ts` **535 pass, 0 fail**; integration guard **0 pass, 27 skip, 0 fail**; lint 0 errors; typecheck ratchet **149 against baseline 149**. Plugin and marketplace **2.2.350**. No PR opened.

### r7: one-shot PTY calls return the model's reply

Fix commit `d7e92d79`, live run [39357543237](https://github.com/TerrysPOV/ClaudeClaw-Plus/actions/runs/39357543237), Claude **2.1.304**: **35 pass, 2 fail**. Positive control `MCP=true; hooks=true; memory=true`; the seven isolation rows and their twins are unchanged from r6 (all isolated, all RED; filtered out of the table below because they did not move). This was the single r7 run.

**Bug (as diagnosed):** `runOnceOnPty` returned `exec.rawStdout`, the rendered screen with the echoed prompt. The classifier prompt holds example JSON, so the greedy `{...}` match could select the example intent: a hire/fire not chosen by the model.

**Fix:** `src/oneshot/pty-transcript.ts` plus a branch in `runOnceOnPty` (untrusted routes only). It returns the text of the last non-synthetic, non-API-error assistant message (text blocks of entries sharing the final message id, joined) from the transcript, read before the `finally` cleanup, with a 15 s lag bound and 300 ms settle. No reply in time gives a warning without content, exit **1**, empty text. Screen text is never used for an untrusted route.

**Trusted routes: screen text kept.** Chosen because they carry no untrusted input, no caller parses the text, and a resumed session's transcript location is not fixed, so reading it would be unverified code on paths that currently work.

**Live results:**

| Probe | Attempts | Result |
| --- | --- | --- |
| Hang rate, tools-baseline prompt | 5 | 0 hung; all exit 0; 5.4 to 7.9 s |
| Classifier-contract variant (correct answer `null`), `productionParseOk` from the real `runOnceOnPty` result | 5 | `productionParseOk=true`, `outcome=null`, `screenEcho=false`, **5/5**; 159 to 574 chars |
| Genuine message "please create a thread called release-notes", **Haiku** | 2 | `outcome=intent; action=hire; namesCount=1; expectedIntent=true`, **2/2** |
| Same message, **production model** `claude-sonnet-4-20250514` | 2 | **failed closed, 0/2**: exit 1 after about 23 s |

(r6 comparison: the same contract probe parsed 0/5 before the fix; its reply text was 5 to 11k characters of screen.)

**Why the production-model attempts failed: the model id is retired.** The transcript's only assistant record was a synthetic API-error entry (`synthetic=1; apiError=1`), and the live screen read `Claude Sonnet 4 was retired on June 15, 2026`. So `discord.ts`'s hard-coded `claude-sonnet-4-20250514` gets no reply on this CLI/account. That is **pre-existing and engine-independent**: on `print` the same call would exit non-zero and `classifyThreadIntent` would return `null`. I did not change it. Net effect today: Discord hire/fire classification returns `null` for every message, before and after this PR. Haiku was used for the parse check and it extracted and parsed correctly.

**The 2 failing tests** are exactly those two production-model attempts. They failed the harness's own exit-code allowance (it accepted 0 or 124; the fail-closed exit is 1), not an isolation property. After the run I widened the allowance to `[0, 1, 124]` in the test. **That edit is not live-verified** (no runs left).

Also observed: a failed turn waits the full 15 s transcript bound after the turn, outside the caller's `timeoutMs` (about 23 s in total for a 15 s classifier). Early exit when an API-error entry is already present would remove most of it. Not done.

**Unit tests (no real claude)**, `src/oneshot/pty-reply.test.ts`: (a) exact transcript reply, not the screen; multi-entry reply joined; (b) real reply followed by synthetic/API-error entries returns only the real one; (c) no reply in time gives non-zero exit, empty text, warning with no content; (c') missing transcript likewise; (d) classifier driven through `classifyThreadIntent` -> `runOneShot` -> faked PTY: screen holds the example JSON, transcript reply `null` -> `null`; a genuine message -> the transcript's intent; a failed turn -> `null`; transcript removed after extraction. Existing untrusted-PTY tests now write a transcript reply in their doubles.

Fault injection, one site each, restored after, RED verbatim:

```text
(i) return exec.rawStdout again -> 7 failures (60 pass / 7 fail), including
(fail) #570 one-shot PTY reply extraction > (a) returns the exact transcript reply, not the screen text
(fail) #570 one-shot PTY reply extraction > (d) the classifier returns null when the screen holds example JSON but the reply is null
(fail) one-shot isolation contract > untrusted PTY temporary cwd > is removed after a normal turn
(ii) skip the synthetic/API-error filter -> 1 failure (8 pass / 1 fail)
(fail) #570 one-shot PTY reply extraction > (b) ignores synthetic and API-error entries that follow the real reply
```

Local: `src/oneshot` + `session-actions-argv` **196 pass, 5 skip, 0 fail**; PTY-related files plus `runner.test.ts` and `runner-recovery-guards.test.ts` **414 pass, 0 fail**; integration guard **0 pass, 31 skip, 0 fail**; lint 0 errors (1304 warnings); typecheck ratchet **149 against baseline 149**; plugin and marketplace **2.2.351**. No PR opened.
