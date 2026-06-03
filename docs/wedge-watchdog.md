# External wedge watchdog

A standalone health/wedge watchdog for a ClaudeClaw+ daemon, run on a 60s
cadence by a systemd user timer. It is **external** (a shell script + timer
that import no daemon code) — defense-in-depth that complements, rather than
replaces, any in-daemon self-heal.

## Why two layers

The daemon's HTTP `/api/health` only tells you the **process** is up. The
failure that actually takes the bot down is different: the underlying `claude`
agent stops producing turns while the daemon — and `/api/health` — stay
perfectly healthy. The process is alive, idle, and deaf. `/api/health`-only
monitoring never fires, so the bot is silently unresponsive for hours until a
human notices.

- **Layer 1 — daemon liveness.** Ping `/api/health`; after `MAX_FAIL`
  consecutive failures, restart. Catches a dead/crashed daemon.
- **Layer 2 — agent wedge.** Daemon is up, but the agent isn't turning. We read
  it straight off the **per-message receipt chain** (issue #207): a receipt that
  closed `timeout` with reason `no_final_reply_within_timeout` is, by
  definition, a real inbound message that never got a reply. That is the wedge,
  made legible. On a fresh one → restart (bounded).

Layer 2 is **inert until the receipt chain is present** (requires #207) and the
receipts file exists; it reads the JSONL only, never daemon internals.

## Bounding (anti-churn)

Restart churn is itself a failure mode — a restart triggers session-id
re-rotation, and a tight restart loop makes things worse. So:

- at most **one wedge-restart per `COOLDOWN`** (default 15 min);
- a fresh wedge **inside** the cooldown does **not** restart — it logs
  `PERSISTENT WEDGE … manual intervention` so a human is pulled in instead of
  the watchdog churning;
- a one-line **post-mortem** (receipt epoch + agent pid/CPU) is logged before
  each restart.

## Install

```sh
install -m755 scripts/claudeclaw-healthcheck.sh    ~/.local/bin/claudeclaw-healthcheck.sh
install -m755 scripts/claudeclaw-wedge-capture.sh  ~/.local/bin/claudeclaw-wedge-capture.sh
install -m755 scripts/claudeclaw-wedge-summary.sh  ~/.local/bin/claudeclaw-wedge-summary.sh
install -m755 scripts/notify-telegram.sh           ~/.local/bin/notify-telegram.sh   # optional alerting
cp systemd/claudeclaw-healthcheck.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claudeclaw-healthcheck.timer
```

(The capture/notify scripts are found next to the watchdog by default, or via
`CLAUDECLAW_WD_CAPTURE` / `CLAUDECLAW_WD_NOTIFY`.)

### Alerting (optional)

On a wedge the watchdog invokes `CLAUDECLAW_WD_NOTIFY` (a command taking one
arg: the message) so the operator is **pushed** a one-line alert —
`[svc] agent wedge -> auto-restarted. cause: main wchan=…, API socket=… .
dossier: …` — instead of having to poll the log. It defaults to the bundled
`notify-telegram.sh` (sends directly via the Bot API, daemon-independent, so it
arrives even while the daemon restarts); set `CLAUDECLAW_WD_NOTIFY=` to disable
or point it at your own Slack/MQTT/email notifier.

**First-run seeding (important):** if a stale `timeout` receipt predates the
watchdog, seed the state so it isn't mistaken for a fresh wedge and restart a
healthy daemon. Set `last_handled` to the newest existing wedge epoch and
`last_restart` to 0 (so the first genuinely new wedge can restart immediately):

```sh
echo "$(date +%s) 0" > "${XDG_RUNTIME_DIR:-/var/tmp}/claudeclaw-wedge.state"
```

Dry-run to verify detection without restarting: `DRYRUN=1 claudeclaw-healthcheck.sh`.

## Config (env, with defaults)

| var | default | meaning |
|---|---|---|
| `CLAUDECLAW_HEALTH_URL` | `http://localhost:4632/api/health` | liveness probe |
| `CLAUDECLAW_SERVICE` | `claudeclaw` | `systemctl --user` unit to restart |
| `CLAUDECLAW_RECEIPTS` | `$HOME/.claude/claudeclaw/receipts.jsonl` | receipt chain log |
| `CLAUDECLAW_WD_COOLDOWN` | `900` | seconds between wedge-restarts |
| `CLAUDECLAW_WD_MAXFAIL` | `3` | Layer-1 consecutive failures before restart |
| `DRYRUN` | `0` | detect + log, never restart |

## Recovery latency & relationship to the in-daemon path

Detection latency floors at the adapter's receipt timeout (default 300s) plus
one timer tick — i.e. the wedge is caught ~5–6 min after it starts, versus
hours unmonitored. Lower the adapter's `receiptTimeoutMs` for a tighter floor.

This external watchdog is intentionally simple and coarse (whole-daemon
restart). A finer, in-daemon reconciliation — agent-scoped respawn with a
captured post-mortem rather than a daemon restart — is tracked separately
(refs #222). The two are complementary: the external watchdog is a safety net
that holds even if the in-daemon path regresses.

## Forensic capture (cause-oriented)

When Layer 2 fires, the watchdog runs `claudeclaw-wedge-capture.sh` against the
agent **before** restarting — the restart clears the very state needed to find
the cause. The dossier (`~/.claude/claudeclaw/wedge-dossiers/<ts>/`) answers
*what the agent is blocked on*, which discriminates the cause:

- **per-thread `/proc/<pid>/task/*/wchan`** (no ptrace) — the kernel function
  each thread sleeps in:
  - a thread in `sk_wait_data`/recv on an ESTABLISHED socket to the API
    ⇒ the model/stream request hung (server/transport side), not the CLI;
  - `futex_wait` ⇒ a lock/deadlock in the CLI;
  - main in `ep_poll` with **no** in-flight API socket ⇒ the CLI considers the
    turn done / lost the prompt (logic bug).
- **fd resolution + `ss -tnpo`** — an ESTABLISHED `:443` socket with a stuck
  queue (request in flight) vs none (idle).
- **session lead-up** — last events, compaction markers, context size — to test
  the compaction-starvation hypothesis (does the wedge follow a compaction /
  large context?).
- system, CLI version, and the triggering receipt.

`strace` / `/proc/<pid>/syscall` add syscall-level detail but need
`ptrace_scope=0` (attempted, noted when skipped); the per-thread `wchan` +
network signals already classify the cause without ptrace.

`claudeclaw-wedge-summary.sh` aggregates the dossiers into a table + tallies
(common `wchan`, API-socket-present), turning "it wedged again" into a named,
evidenced cause across incidents — what an upstream `needs-repro` triage needs.

Refs #207 (receipt chain), #222 (in-daemon connection reconciliation),
anthropics/claude-code#64496 (the upstream model-hang this most often catches).
