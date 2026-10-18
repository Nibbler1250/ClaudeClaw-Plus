# PTY is the default engine

On upgrade, a missing `pty.enabled` setting now selects the interactive Claude
PTY engine for runner agent turns and scheduled jobs. Bootstrap, model fallback,
stale or corrupted session recovery and post-compaction retries follow that
setting too. An existing literal `false` is preserved. Invalid values such as
`"false"` warn and use the default `true`.

Agents spawned without the settings resolver now default to `pty-stdin` for
every origin, including cron, heartbeat, CLI and REST. Declared agents processed
by `resolveBusAgentConfig` already defaulted to PTY; this change affects agents
that relied on the origin fallback to select print. Non-channel
deliveries use the existing delivery-confirmation loop: typing Enter alone does
not count as successful delivery. Dispatched-job results use the `cron` origin
and an `agent-job:` identifier and pass through the same loop.

## Keep print mode

`claude -p` remains supported. Set both the runner opt-out and explicit bus-agent
supervision overrides in `.claude/claudeclaw/settings.json`:

```json
{
  "pty": { "enabled": false },
  "agents": [
    { "id": "default", "supervision": "process-stream-json" }
  ]
}
```

Preserve the other fields in your settings and repeat the supervision override
for every bus agent you want on print. `pty.enabled` controls runner turns and
cron jobs; each bus agent's `supervision` controls that bus agent independently.
Changing one does not change the other.

Runner paths read `pty.enabled` on each turn. The daemon reloads settings about
every 30 seconds, so a flip applies to subsequent runner turns and cron jobs
after that reload. Bus-agent supervision and runtime selection require a
restart: changing settings on disk does not replace their existing processes.
Restarting also produces a fresh startup summary of the engine choices.

## Verify the switch

With defaults, the startup summary contains:

```text
Engines: agent turns=pty; cron jobs=pty; bus non-channel default=pty-stdin; bus agents=default=pty-stdin
```

Explicit print settings appear as `print` and `process-stream-json` respectively.
The agent list reflects each declared override. Check the actual bus spawn lines
and PTY-supervisor spawn/turn logs after sending a chat message and running a due
job; a startup setting alone does not prove a successful turn.

Inspect process flags locally. This command reports PID and mode while keeping
the rest of the command line out of the output:

```sh
uv run --no-project python - <<'PY'
import os, shlex, subprocess
for row in subprocess.check_output(["ps", "-axo", "pid=,args="], text=True).splitlines():
    try:
        pid, command = row.strip().split(None, 1)
        argv = shlex.split(command)
    except ValueError:
        continue
    if argv and os.path.basename(argv[0]) == "claude":
        print(pid, "print" if any(a in ("-p", "--print") for a in argv[1:]) else "no print flag")
PY
```

The Claude processes serving default agent turns and cron jobs should have no
`-p` or `--print` flag. Match the PID to the corresponding spawn log. Explicit
print overrides and utility one-shot calls can legitimately show print mode.
Utility migrations are managed separately by #548/#549; they are not controlled
by this default change.

## Rollout requirements

Issue #559 is a merge blocker: fresh PTY chat input with the runner's timestamp
prefix can remain unsubmitted until timeout. Merge and verify that fix before
rolling out these defaults. The module changes do not prove that live bug fixed.

The operator must complete the 48-hour soak in the issue #550 implementation
report, covering chat, cron jobs, dispatched jobs, a restart and compaction.
This migration guide accompanies the code change; the README link and defaults
update follow PR #558's README rewrite.
