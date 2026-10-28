#!/bin/bash
# Soak harness configuration. Source this file; every variable can be overridden from the environment.
#   . soak/env.sh
# Nothing here points at your real home: the isolated install lives entirely under SOAK_BASE.

_soak_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

: "${SOAK_BASE:=$HOME/.local/state/ccplus-soak}"   # root of the isolated install (never your real home)
: "${SOAK_HOME:=$SOAK_BASE/home}"                   # HOME of the isolated daemon and of every claude it spawns
: "${SOAK_WS:=$SOAK_BASE/ws}"                       # daemon working directory (holds .mcp.json and .claude/claudeclaw)
: "${SOAK_TMP:=$SOAK_BASE/tmp}"                     # TMPDIR (claudeclaw-oneshot-* dirs land here)
: "${SOAK_RUN:=$SOAK_BASE/run}"                     # XDG_RUNTIME_DIR (daemon socket dir)
: "${SOAK_RESULTS:=$SOAK_BASE/results}"             # instance log, plugin outputs, one dir per run
: "${SOAK_PORT:=18562}"                             # web/API port of the isolated daemon (127.0.0.1 only)
: "${SOAK_REPO:=$(cd "$_soak_here/.." && pwd)}"     # checkout the isolated daemon runs from (this one by default)
: "${SOAK_UNIT_PREFIX:=ccplus-soak-instance}"       # systemd --user transient unit name prefix for the instance
: "${SOAK_LIVE_UNIT:=claudeclaw.service}"           # a live daemon unit to watch (MainPID read only); empty = none
: "${SOAK_TZ:=UTC}"                                 # timezone written into the isolated settings.json
: "${SOAK_LIVE_CREDENTIALS:=$HOME/.claude/.credentials.json}"  # read-only source of the access token
: "${BUN:=$(command -v bun 2>/dev/null || echo bun)}"
: "${SOAK_CLAUDE_BIN:=$(readlink -f "$(command -v claude 2>/dev/null)" 2>/dev/null)}"  # claude CLI >= 2.1.304

export SOAK_BASE SOAK_HOME SOAK_WS SOAK_TMP SOAK_RUN SOAK_RESULTS SOAK_PORT SOAK_REPO SOAK_UNIT_PREFIX \
  SOAK_LIVE_UNIT SOAK_TZ SOAK_LIVE_CREDENTIALS BUN SOAK_CLAUDE_BIN
unset _soak_here
