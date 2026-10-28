# Soak harness (isolated daemon)

Runs a second, fully isolated ClaudeClaw-Plus daemon from this checkout and drives it for hours with
nonce turns, untrusted one-shots and six fault scenarios, then reports counts and pass/fail. It needs no
LLM of its own: every prompt is `Reply with exactly: N-<8 hex>`, and the verdict comes from the session
transcripts and from `/proc`.

It never touches a live daemon (a live unit is only read for its MainPID), never writes your real
`~/.claude`, and only reads the credentials file it copies the access token from.

## What it measures

- **False completions.** A turn the daemon reports as done (exit 0) with no new assistant entry carrying
  its nonce in the session JSONL at the moment it returned. Every bus and runner turn is rechecked at
  +120 s (`MISSING` / `DUP_PROMPT`). Cron turns are checked from the job log (`Session:`, `Exit code:`,
  prompt nonce) against the transcript; a stale nonce (prompt not rewritten) is flagged too.
- **Paths.** Runner (`runUserMessage`, PTY `global`), bus agent `default` (`POST /api/inject`), cron
  (two haiku jobs, `*/6` and `3-59/6`), untrusted one-shots (`runOneShot({route, isolation:"untrusted"})`,
  routes rotate over `tuner.judge`, `tuner.propose`, `memory.recall`, `discord.classifier`; the engine
  must be `pty`).
- **Processes.** `/proc` sampled every 60 s into `ps.csv` (fast 0.5 s sampling during some scenarios):
  any `claude -p`, two live processes on one session, and orphans. An **orphan** is an isolated claude
  or fake MCP server that does not descend from the current instance main PID (counted after each
  scenario, again at +120 s, and after the final stop).
- **One-shot temp dirs.** At the end, `claudeclaw-oneshot-*` dirs left in the isolated TMPDIR after the
  daemon's sweeper had up to 25 min to remove them.
- **Quarantines and `/status` group-unconfirmed counter**, via the supervisor snapshot every 5 min.

Every agent (runner, cron threads, bus) gets three stdio MCP servers from `ws/.mcp.json`
(`mcp/fake_mcp.py`, behaviour from the executable name):

| Name | SIGTERM | SIGHUP / stdin EOF |
|---|---|---|
| `mcp-ok` | exits | exits |
| `mcp-slow` | exits after ~5 s | ignored |
| `mcp-deaf` | ignored (SIGKILL only) | ignored |

### Scenarios

| | What the harness does | Pass when |
|---|---|---|
| a | `/kill` (`killActiveReport`) 2-5 s into a runner turn that runs a 20 s Bash loop | no false completion, no claude/MCP left at +15 s, no orphan, follow-up nonce ok |
| b | stop the isolated daemon, start it again | no claude/MCP left after stop, runner and bus nonces ok after restart |
| c | `SessionManager.clearSession("default")` on the bus agent | old claude and its MCP servers gone within 30 s, no orphan, bus nonce ok, at most one bus claude |
| d | `/compact` on the bus agent, then a nonce | nonce ok, no second writer on a session, no orphan |
| e | SIGKILL the claude of an idle agent (alternates runner / bus) | every MCP server of that claude gone (while idle, or after the next turn), no orphan, follow-up nonce ok |
| f | retire an agent (`retirePtySession("global")` for the runner, `SessionManager.restart` for the bus) | retire ok, `mcp-slow` and `mcp-deaf` were attached and are gone within 30 s, no orphan, follow-up ok |

Scenario e records, per MCP PID, `gone_idle_s` (seconds until it disappeared while the agent stayed idle,
or `null`) and `gone_after_next_turn_s`. The idle window is 60 s by default; `--e-idle-seconds N`
lengthens it to tell a delayed reap apart from a leak.

## Requirements

- Linux with `/proc` and a systemd user session (`systemd-run --user`).
- `bun`, and `bun install` done in the checkout the daemon runs from (`SOAK_REPO`).
- A claude CLI >= 2.1.304 (`SOAK_CLAUDE_BIN`).
- A logged-in claude credentials file to copy the access token from (`SOAK_LIVE_CREDENTIALS`).
- `python3` (stdlib only), at `/usr/bin/python3` for the MCP stubs' shebang.
- About 10 GB free on the SOAK_BASE filesystem (the pilot stops below that).

## Configuration

All variables live in `soak/env.sh`; override any of them in the environment before sourcing it.

| Variable | Default | Meaning |
|---|---|---|
| `SOAK_BASE` | `$HOME/.local/state/ccplus-soak` | root of the isolated install |
| `SOAK_HOME` | `$SOAK_BASE/home` | HOME of the isolated daemon and of every claude it spawns |
| `SOAK_WS` | `$SOAK_BASE/ws` | daemon working dir (`.mcp.json`, `.claude/claudeclaw/`) |
| `SOAK_TMP` | `$SOAK_BASE/tmp` | TMPDIR |
| `SOAK_RUN` | `$SOAK_BASE/run` | XDG_RUNTIME_DIR (socket dir) |
| `SOAK_RESULTS` | `$SOAK_BASE/results` | instance log, plugin replies, one dir per run |
| `SOAK_PORT` | `18562` | web/API port, bound to 127.0.0.1 |
| `SOAK_REPO` | this checkout | repo the daemon runs from (`src/index.ts`) |
| `SOAK_CLAUDE_BIN` | resolved `claude` on PATH | claude CLI linked as `$SOAK_BASE/bin/claude` |
| `BUN` | `bun` on PATH | bun binary |
| `SOAK_LIVE_CREDENTIALS` | `$HOME/.claude/.credentials.json` | read-only source of the access token |
| `SOAK_UNIT_PREFIX` | `ccplus-soak-instance` | transient unit name prefix for the instance |
| `SOAK_LIVE_UNIT` | `claudeclaw.service` | live daemon unit whose MainPID is watched for changes; empty = none |
| `SOAK_TZ` | `UTC` | timezone written into the isolated settings |

`setup.sh` generates a random `apiToken` for the isolated daemon. Only the access token is copied into
the isolated credentials file; the refresh token is blanked, so the isolated install never refreshes
(and never rotates) your login. During a run the pilot re-copies it whenever the source file's mtime
changes; it never writes the source.

## Run order

```bash
. soak/env.sh                                   # or export overrides first
(cd "$SOAK_REPO" && bun install)
soak/setup.sh                                   # isolated dirs, config, MCP stubs, jobs, token copy
python3 -I soak/pilot.py start-instance         # prints "up <unit>" once /api/health answers
python3 -I soak/pilot.py short                  # proof cycle, ~20-40 min
python3 -I soak/pilot.py soak --hours 8         # stops on counts; --hours is the ceiling
python3 -I soak/pilot.py summary "$SOAK_RESULTS/current-soak"
python3 -I soak/pilot.py stop-instance
```

`short` first injects four fake completions (runner, bus, one-shot, cron) that **must** come back as
`FALSE_COMPLETION`, then runs 5 runner/bus nonces, 2 one-shots and one of each scenario (e and f on both
runner and bus). `--plan x,y,...` picks the steps (`fake fake_bus fake_oneshot fake_cron r bus o a b c d
e e_bus f f_bus state`).

`soak` runs a block about every 6 min: one scenario in rotation (a to f; e and f alternate runner and
bus), one runner nonce, one bus nonce, two one-shots; the two cron jobs run on their own. It stops when
it has 150 trusted turns (runner + bus + cron), 100 one-shots and 10 runs of each scenario, or at the
`--hours` ceiling, then drains, waits for the one-shot sweep, stops the instance and counts orphans.

For a long soak, run the pilot detached so it survives your shell, e.g.:

```bash
systemd-run --user --unit=ccplus-soak-pilot --same-dir \
  $(env | grep -E '^(SOAK_|BUN=)' | sed 's/^/--setenv=/') \
  /usr/bin/python3 -I soak/pilot.py soak --hours 8
```

### Stopping safely

Send **SIGTERM** to the pilot (`kill -TERM <pid>`, or `systemctl --user kill -s TERM ccplus-soak-pilot`).
It finishes the current step, drains pending rechecks (max 10 min), stops the instance, does the final
orphan count and writes the summary. Do not SIGKILL it and do not `systemctl stop` the pilot unit (that
escalates to SIGKILL after the stop timeout): the isolated daemon would keep running. If that happens,
`python3 -I soak/pilot.py stop-instance` stops it.

## Outputs

Per run, `$SOAK_RESULTS/<mode>-<UTC stamp>/` (`current-<mode>` points at the latest):

- `meta.json`: sha, branch, plugin version, claude version, OS, targets, e idle window.
- `events.jsonl`: one line per turn, recheck, one-shot, scenario, process seen/gone, log match, state poll.
- `ps.csv`: per-minute process counts.
- `summary.json` and `counts.md`: counts and pass/fail only (no transcript text, no environment), safe
  to paste into an issue.

`$SOAK_RESULTS/instance.log` is the isolated daemon's log; `$SOAK_RESULTS/plugin/` holds the plugin's
replies. None of this is meant to be committed (`soak/.gitignore`).

## Pass criteria

`summary.json` `verdict` is `PASS` when all of these hold:

- 0 false completions (turns and one-shots);
- 0 `claude -p` processes;
- 0 orphan claude/MCP after scenarios, at +120 s and after the final stop;
- no quarantine left at the last supervisor poll;
- 0 `claudeclaw-oneshot-*` dirs after the sweep;
- every one-shot ran on the `pty` engine;
- every scenario run is `ok`.

In a `short` run, also check that `detector_proof(fake)` shows `flagged == injected` (4/4).

## Known limits

- **Linux only.** These functions read `/proc` and need a `ps`/`libproc`-based replacement on macOS:
  `isolated_procs` (environ, cmdline, exe, stat), `mcp_procs` (cmdline, comm, stat), `all_ppids`
  (stat), `is_isolated` and `kill_isolated` (environ), `watch_gone`, `stop_instance` and the scenario
  checks (`/proc/<pid>` existence). Instance control also assumes `systemd-run --user`.
- **Bus agent not respawned after its claude crashes** (upstream issue #605). In scenario e (bus) the
  daemon logs `exited outside stop()` and does not bring the agent back, so the harness restarts the
  isolated daemon to recover it and counts orphans at that stop too (`e_bus_respawned_by_pilot`).
- **Runner MCP servers survive an idle SIGKILL** (upstream issue #606). After the runner claude is
  killed while idle, `mcp-slow` and `mcp-deaf` can outlive the idle window and only go after the next
  turn on that agent. Scenario e passes if they are gone after that turn and reports
  `e_retired_while_idle` separately; use `--e-idle-seconds` to measure the delay.
- **First turn on a resumed session can be refused** (`PTY prompt not accepted`). The daemon reports
  it as a failure (exit 1, not a false completion); scenarios e and f retry the preparatory turn once.
- One-shots are triggered through the plugin calling `runOneShot` inside the daemon, not by the tuner's
  own scheduler.

## Safety notes

- Never point `SOAK_HOME` (or `SOAK_BASE`) at a real home. `setup.sh`, `instance.sh` and the pilot refuse
  your own `$HOME`.
- Every signal the pilot sends goes to a PID whose `/proc/<pid>/environ` contains `HOME=<SOAK_HOME>`
  (SIGTERM, then SIGKILL after 5 s). Scenario e's SIGKILL is checked the same way.
- The isolated daemon binds 127.0.0.1 only and uses its own generated token.
- Run outputs contain session ids and PIDs; `counts.md` is the only file meant to be shared.

## Files

- `env.sh`: variables and defaults.
- `setup.sh`: creates the isolated install (idempotent).
- `instance.sh`: runs the isolated daemon under `env -i` (started by `pilot.py start-instance`).
- `pilot.py`: the pilot and the summary.
- `plugin/index.js`: daemon plugin (trigger-file protocol) that calls `runUserMessage`,
  `killActiveReport`, `retirePtySession`, `runOneShot`, `snapshotSupervisor` and the captured bus
  `SessionManager`.
- `mcp/fake_mcp.py` and the `mcp-ok`, `mcp-slow`, `mcp-deaf` symlinks.
