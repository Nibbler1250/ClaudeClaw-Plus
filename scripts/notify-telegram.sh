#!/usr/bin/env bash
# Send a one-line operator alert to Telegram, directly via the Bot API
# (independent of the daemon, so it works even while the daemon is restarting).
# Usage: notify-telegram.sh "message"
set -u
MSG="${1:-}"
[ -z "$MSG" ] && exit 0
SETTINGS="${CLAUDECLAW_SETTINGS:-$HOME/agent/.claude/claudeclaw/settings.json}"
TOKEN=$(python3 -c "import json;print(json.load(open('$SETTINGS')).get('telegram',{}).get('token',''))" 2>/dev/null)
CHAT=$(python3  -c "import json;l=json.load(open('$SETTINGS')).get('telegram',{}).get('allowedUserIds',[]);print(l[0] if l else '')" 2>/dev/null)
[ -z "$TOKEN" ] && exit 0
[ -z "$CHAT" ]  && exit 0
curl -sS -m 10 "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT}" \
  --data-urlencode "text=${MSG}" \
  --data-urlencode "disable_notification=false" >/dev/null 2>&1 || true
