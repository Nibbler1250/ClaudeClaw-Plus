#!/usr/bin/env bash
# External two-layer health/wedge watchdog for a ClaudeClaw+ daemon.
#
# Layer 1 — daemon liveness: ping /api/health. After MAX_FAIL consecutive
#   failures, restart the service. Catches a dead/crashed daemon.
#
# Layer 2 — agent wedge: /api/health stays 200 while the underlying `claude`
#   agent stops producing turns — the CLI's model execution hangs
#   (anthropics/claude-code#64496) or the prompt never reaches the agent. This
#   is invisible to Layer 1, so the bot goes silently deaf for hours. We detect
#   it from the per-message receipt chain (issue #207): a receipt that closed
#   `timeout` with reason `no_final_reply_within_timeout` means a real inbound
#   message went unanswered. Bounded: at most one wedge-restart per COOLDOWN; a
#   fresh wedge inside the window escalates to a log alert instead of churning
#   (restart churn is itself a failure mode — session-id rotation storms).
#
# Layer 2 is a no-op until the receipt chain is present (REQUIRED: #207). It
# imports no daemon code — it only reads the receipts JSONL and calls systemctl.
#
# Config (env, with defaults):
#   CLAUDECLAW_HEALTH_URL   default http://localhost:4632/api/health
#   CLAUDECLAW_SERVICE      default claudeclaw            (systemctl --user unit)
#   CLAUDECLAW_RECEIPTS     default $HOME/.claude/claudeclaw/receipts.jsonl
#   CLAUDECLAW_WD_COOLDOWN  default 900   (seconds between wedge-restarts)
#   CLAUDECLAW_WD_MAXFAIL   default 3     (Layer-1 consecutive failures)
#   DRYRUN=1                detect + log, never restart

set -u

URL="${CLAUDECLAW_HEALTH_URL:-http://localhost:4632/api/health}"
SERVICE="${CLAUDECLAW_SERVICE:-claudeclaw}"
RECEIPTS="${CLAUDECLAW_RECEIPTS:-$HOME/.claude/claudeclaw/receipts.jsonl}"
COOLDOWN="${CLAUDECLAW_WD_COOLDOWN:-900}"
MAX_FAIL="${CLAUDECLAW_WD_MAXFAIL:-3}"
TIMEOUT=5
DRYRUN="${DRYRUN:-0}"
CAPTURE="${CLAUDECLAW_WD_CAPTURE:-$(dirname "$(readlink -f "$0")")/claudeclaw-wedge-capture.sh}"
# Optional operator-alert hook: a command invoked with one arg (the message).
# Defaults to the bundled notify-telegram.sh if present; set to "" to disable,
# or to your own notifier (Slack/MQTT/email/…).
NOTIFY="${CLAUDECLAW_WD_NOTIFY:-$(dirname "$(readlink -f "$0")")/notify-telegram.sh}"
DROOT="${CLAUDECLAW_WD_DOSSIERS:-$HOME/.claude/claudeclaw/wedge-dossiers}"

STATE_DIR="${XDG_RUNTIME_DIR:-/var/tmp}"
STATE="$STATE_DIR/claudeclaw-healthcheck.state"
WSTATE="$STATE_DIR/claudeclaw-wedge.state"
LOG="${CLAUDECLAW_WD_LOG:-${XDG_STATE_HOME:-$HOME/.local/state}/claudeclaw/healthcheck.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

now() { date '+%Y-%m-%dT%H:%M:%S%z'; }
epoch() { date '+%s'; }
restart_service() { [ "$DRYRUN" = "1" ] || systemctl --user restart "$SERVICE"; }

# ── Layer 1: daemon liveness ────────────────────────────────────────────────
[ -f "$STATE" ] && fails=$(cat "$STATE") || fails=0
http_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$URL" 2>/dev/null || echo "000")

if [ "$http_code" = "200" ]; then
  if [ "$fails" -gt 0 ]; then echo "$(now) recovered after $fails fail(s)" >> "$LOG"; fi
  echo 0 > "$STATE"
else
  fails=$((fails + 1)); echo "$fails" > "$STATE"
  echo "$(now) fail #$fails (http=$http_code)" >> "$LOG"
  if [ "$fails" -ge "$MAX_FAIL" ]; then
    echo "$(now) RESTART $SERVICE after $fails consecutive fails (daemon)" >> "$LOG"
    restart_service
    echo 0 > "$STATE"
  fi
  exit 1   # daemon down — skip the wedge check this tick
fi

# ── Layer 2: agent wedge (daemon is up) ─────────────────────────────────────
[ -f "$RECEIPTS" ] || exit 0   # no receipt chain → Layer 2 inert

# Newest unanswered-turn receipt epoch (timeout + no_final_reply), 0 if none.
# The receipts path is passed as argv so the heredoc can own stdin (the program).
wedge_epoch=$(python3 - "$RECEIPTS" 2>/dev/null <<'PY'
import sys, json, datetime
latest = 0
try:
    lines = open(sys.argv[1]).read().splitlines()[-80:]
except Exception:
    lines = []
for line in lines:
    line = line.strip()
    if not line:
        continue
    try:
        r = json.loads(line)
    except Exception:
        continue
    if r.get("final_state") != "timeout":
        continue
    # Only real unanswered turns — exclude stop-drain / supersede closures.
    if (r.get("notes") or {}).get("reason") != "no_final_reply_within_timeout":
        continue
    ts = r.get("received_at", "")
    try:
        e = int(datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp())
    except Exception:
        continue
    if e > latest:
        latest = e
print(latest)
PY
)
wedge_epoch=${wedge_epoch:-0}

if [ -f "$WSTATE" ]; then
  read -r last_handled last_restart < "$WSTATE" 2>/dev/null || { last_handled=0; last_restart=0; }
else
  last_handled=0; last_restart=0
fi
last_handled=${last_handled:-0}; last_restart=${last_restart:-0}
N=$(epoch)

# A fresh wedge = an unanswered-turn receipt newer than the last one handled.
if [ "$wedge_epoch" -gt "$last_handled" ]; then
  since=$(( N - last_restart ))
  pid=$(pgrep -f 'claude --plugin-dir' | head -1)
  cpu=$(ps -p "${pid:-0}" -o pcpu= 2>/dev/null | tr -d ' '); cpu=${cpu:-?}
  echo "$(now) WEDGE detected: unanswered-turn receipt @${wedge_epoch} (agent pid=${pid:-none} cpu=${cpu}%)" >> "$LOG"
  # Cause-oriented forensic capture BEFORE the restart clears the state.
  if [ -x "$CAPTURE" ] && [ -n "${pid:-}" ]; then
    bash "$CAPTURE" "$pid" "$wedge_epoch" && echo "$(now) forensic dossier captured" >> "$LOG"
  fi

  # One-line cause from the freshest dossier (for the alert).
  lastd=$(ls -1dt "$DROOT"/*/ 2>/dev/null | head -1)
  wchan="?"; api="?"
  if [ -n "$lastd" ] && [ -f "$lastd/dossier.txt" ]; then
    wchan=$(grep -m1 '^main/wchan:' "$lastd/dossier.txt" | awk '{print $2}')
    grep -E '^ESTAB' "$lastd/dossier.txt" 2>/dev/null | grep -qE ':443\b' && api=yes || api=no
  fi
  cause="main wchan=${wchan:-?}, API socket=${api}"

  if [ "$since" -ge "$COOLDOWN" ]; then
    echo "$(now) RESTART $SERVICE (agent wedge; ${since}s since last wedge-restart)" >> "$LOG"
    restart_service
    echo "$wedge_epoch $N" > "$WSTATE"
    action="auto-restarted"
  else
    echo "$(now) PERSISTENT WEDGE within ${COOLDOWN}s cooldown (${since}s since last restart) — NOT auto-restarting, manual intervention" >> "$LOG"
    echo "$wedge_epoch $last_restart" > "$WSTATE"
    action="PERSISTENT — manual intervention (no restart)"
  fi

  # Optional operator alert (best-effort, daemon-independent).
  if [ -n "${NOTIFY:-}" ] && [ -x "$NOTIFY" ] && [ "$DRYRUN" != "1" ]; then
    "$NOTIFY" "[$SERVICE] agent wedge -> ${action}. cause: ${cause}. dossier: ${lastd:-?}" || true
  fi
fi

exit 0
