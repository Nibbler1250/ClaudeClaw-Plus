#!/usr/bin/env bash
# Cause-oriented forensic capture for a wedged claudeclaw agent.
# Usage: claudeclaw-wedge-capture.sh <agent_pid> [wedge_epoch] [dossier_root]
#
# Goal: answer WHAT the agent is blocked on, to distinguish the cause —
#   - thread in sk_wait_data/*recv* on an ESTABLISHED socket to the API
#       => the model/API request hung (server/stream side), not the CLI.
#   - thread in futex_wait                  => a lock/deadlock in the CLI.
#   - main thread in ep_poll, no in-flight API socket
#       => the CLI considers the turn done / lost the prompt (logic bug).
#
# Core signals need NO ptrace (/proc/<pid>/wchan, per-thread wchan, fd, ss).
# strace + /proc/<pid>/syscall are attempted only if ptrace is permitted.
set -u

PID="${1:?agent pid}"
WEDGE_EPOCH="${2:-0}"
ROOT="${3:-$HOME/.claude/claudeclaw/wedge-dossiers}"
RECEIPTS="${CLAUDECLAW_RECEIPTS:-$HOME/.claude/claudeclaw/receipts.jsonl}"
KEEP="${CLAUDECLAW_WD_KEEP:-30}"

ts=$(date '+%Y%m%dT%H%M%S')
DIR="$ROOT/${ts}-pid${PID}"
mkdir -p "$DIR"
exec >>"$DIR/dossier.txt" 2>&1

echo "=== claudeclaw wedge dossier ==="
echo "captured_at:  $(date -Is)"
echo "agent_pid:    $PID"
echo "wedge_epoch:  $WEDGE_EPOCH"
echo "cli_version:  $(claude --version 2>/dev/null || echo '?')"
echo "ptrace_scope: $(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo '?')"
echo

if [ ! -d "/proc/$PID" ]; then echo "PROCESS GONE before capture"; exit 0; fi

echo "=== BLOCKED-ON (no ptrace — the cause discriminator) ==="
echo "main/wchan: $(cat /proc/$PID/wchan 2>/dev/null)"
echo "state:      $(awk -F'\t' '/^State:/{print $2}' /proc/$PID/status 2>/dev/null)"
echo "-- per-thread: tid comm wchan --"
for t in /proc/$PID/task/*; do
  printf '  %-8s %-18s %s\n' "${t##*/}" "$(cat "$t/comm" 2>/dev/null)" "$(cat "$t/wchan" 2>/dev/null)"
done
echo "-- wchan histogram (what threads are stuck in) --"
for t in /proc/$PID/task/*; do cat "$t/wchan" 2>/dev/null; echo; done | sort | uniq -c | sort -rn
echo

echo "=== current syscall (/proc/PID/syscall; ptrace-gated) ==="
cat "/proc/$PID/syscall" 2>&1 | head -1
echo

echo "=== strace 6s (opportunistic) ==="
if [ "$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo 1)" = "0" ]; then
  timeout 7 strace -f -p "$PID" -e trace=read,recvfrom,recvmsg,futex,epoll_wait,poll,write,sendto -tt 2>&1 | head -50
else
  echo "SKIPPED: ptrace_scope != 0 — set it to 0 (root) for syscall-level capture."
fi
echo

echo "=== OPEN FDS ==="
echo "-- fd target histogram --"
ls -l "/proc/$PID/fd" 2>/dev/null | awk '/->/{print $NF}' | sed -E 's/\[?[0-9]+\]?$//' | sort | uniq -c | sort -rn | head -15
echo "-- socket fds --"
ls -l "/proc/$PID/fd" 2>/dev/null | grep -i socket | head -20
echo

echo "=== NETWORK (ss, this pid) ==="
ss -tnpo 2>/dev/null | grep "pid=$PID," | head -25
echo "-- ESTABLISHED to :443 (API) or :4632 (bus) with queue/timers --"
ss -tnpo 2>/dev/null | grep "pid=$PID," | grep -E ':443|:4632'
echo

echo "=== VITALS ==="
ps -p "$PID" -o pid,ppid,%cpu,%mem,rss,nlwp,etime,stat 2>/dev/null
echo "fd_count: $(ls /proc/$PID/fd 2>/dev/null | wc -l)"
echo

echo "=== SESSION lead-up (compaction hypothesis) ==="
SID=$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null | grep -oE 'session-id [0-9a-f-]+' | awk '{print $2}')
SJ=$(ls -t "$HOME"/.claude/projects/*/"$SID".jsonl 2>/dev/null | head -1)
if [ -n "${SJ:-}" ] && [ -f "$SJ" ]; then
  echo "session_file: $SJ"
  echo "size_bytes:   $(wc -c < "$SJ")   events: $(wc -l < "$SJ")"
  echo "compaction_events_in_session: $(grep -ci -e compact -e isCompactSummary "$SJ" 2>/dev/null)"
  echo "-- last 25 events: ts | type | flags --"
  tail -25 "$SJ" | python3 -c '
import sys, json
for l in sys.stdin:
    l=l.strip()
    if not l: continue
    try: r=json.loads(l)
    except: continue
    t=r.get("type","")
    ts=(r.get("timestamp","") or "")[11:23]
    flags=[]
    s=json.dumps(r).lower()
    if "compact" in s: flags.append("COMPACT")
    if r.get("isApiErrorMessage") or "rate_limit" in s or "overloaded" in s: flags.append("APIERR")
    if t=="assistant":
        for b in (r.get("message",{}) or {}).get("content",[]) or []:
            if isinstance(b,dict) and b.get("type")=="tool_use": flags.append("tool:"+str(b.get("name")))
    print(" ", ts, t, " ".join(flags))
' 2>/dev/null
  echo "-- gap: last event vs now --"
  python3 -c '
import sys, json, datetime
last=None
for l in open(sys.argv[1]).read().splitlines()[-50:]:
    try: r=json.loads(l)
    except: continue
    ts=r.get("timestamp")
    if ts: last=ts
if last:
    e=datetime.datetime.fromisoformat(last.replace("Z","+00:00"))
    print("  last_event:", last, " age_s:", int(datetime.datetime.now(datetime.timezone.utc).timestamp()-e.timestamp()))
else:
    print("  no timestamp")
' "$SJ" 2>/dev/null
else
  echo "session jsonl not found (sid=${SID:-?})"
fi
echo

echo "=== SYSTEM ==="
free -h 2>/dev/null | head -2
uptime
echo

echo "=== TRIGGERING WEDGE RECEIPT ==="
tail -30 "$RECEIPTS" 2>/dev/null | python3 -c '
import sys, json
best=None
for l in sys.stdin:
    l=l.strip()
    if not l: continue
    try: r=json.loads(l)
    except: continue
    if r.get("final_state")=="timeout" and (r.get("notes") or {}).get("reason")=="no_final_reply_within_timeout":
        best=r
print(json.dumps(best, indent=2) if best else "no matching wedge receipt")
' 2>/dev/null

# Rotate: keep the newest $KEEP dossiers.
ls -1dt "$ROOT"/*/ 2>/dev/null | tail -n +"$((KEEP+1))" | xargs -r rm -rf
exit 0
