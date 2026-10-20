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
