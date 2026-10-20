# #570: interactive untrusted isolation spike

## Problem

Untrusted utility calls currently need print or an explicitly selected HTTP engine. Terry selected interactive PTY isolation (brief v2, 2026-10-20); an HTTP default would leave users without API credentials on print.

## Current behaviour (file:line)

- `src/runner/pty-process.ts:388`: the untrusted argv branch already spreads `UNTRUSTED_CLAUDE_ARGS`, without session, tool grants, persona or MCP flags.
- `src/runner/pty-supervisor.ts:1674`: `runOnceOnPty` creates/removes an empty cwd, disables multiplexer configuration, but does not remove Claude's external project transcript directory.
- `src/runner/pty-supervisor.ts:1485`: PTY uses the general runner environment; print's per-caller allowlist is not consulted here. This is a suspected isolation gap to measure, not assume safe.
- `src/oneshot/registry.ts:20`: PTY advertises isolation false. `src/oneshot/config.ts:40` only gives trusted resume routes an implicit PTY default.
- `src/oneshot/print.ts:50`: print consults its async-local caller environment. `src/commands/discord.ts:612` supplies the classifier allowlist.
- Installed local Claude 2.1.304 help explicitly documents `--no-session-persistence` as print-only. Throwaway-config local auth returned loggedIn false; no credentials were accessed/copied. The addendum authorizes CI's existing secret-scoped workflow instead.

## Target behaviour

Capture argv through the actual untrusted `runOnceOnPty` path; prove tools, MCP, settings/hooks, memory, commands, cwd/transcript and environment isolation against real Claude on disposable CI. Every property has a control-removed twin. Remove the unique temp-cwd transcript directory after PTY retirement as compensation for the print-only flag.

Only after every probe and twin succeeds: advertise PTY isolation and default untrusted routes to PTY with pty.enabled true; explicit routes/defaults win, false/Windows defaults use print. Otherwise retain the gate and report the measured failures.

## Frozen decisions

- Brief v2 and addendum replace option B. HTTP stays explicit opt-in. The option B draft and its tests remain in named stashes.
- No local live authentication/model calls. Integration tests run only when CI=true and GITHUB_ACTIONS=true, on a throwaway HOME/config with the workflow's existing token environment; never inspect/log/copy the token.
- A temporary in-test capability override permits the spike to exercise the gated path; it is restored after every test and does not enable production routing.
- Record only argv, nonsecret canaries, statuses and booleans. Do not log raw PTY screens, environments or transcripts, which might contain credentials.
- Use unique temporary directories and restore environment/test seams. Transcript cleanup removes only the project directory derived from that unique temporary cwd, never a parent or another project's files.
- No retrying into a different engine. Red probes block the capability/default change.

## Key files

`src/oneshot/isolation.ts`, `src/oneshot/registry.ts`, `src/oneshot/config.ts`, `src/runner/pty-process.ts`, `src/runner/pty-supervisor.ts`, `tests/integration/untrusted-pty-isolation.test.ts`, `.github/workflows/integration.yml`, `docs/spikes/0.7-interactive-isolation.md`.

## Out of scope

Operator credentials/configuration, #559, unrelated integration failures, PR creation/merge, HTTP defaults, memory-recall Python migration. Leave existing untracked `.planning/559-pty-submit/`, `.serena/` and scratchpad files alone.

## Execution checklist

1. Add CI-only real probes/twins, argv parity and transcript cleanup tests.
2. Observe unit RED, add compensation, inject one missing argv flag and restore.
3. Run scoped unit contracts/lint, bump both versions, commit and push spike only.
4. Dispatch/watch one integration workflow. Record each measured result.
5. If all properties green and twins red, implement Step 3 and dispatch once more; otherwise stop and report blockers.
