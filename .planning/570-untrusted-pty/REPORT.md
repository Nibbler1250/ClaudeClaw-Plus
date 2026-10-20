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
