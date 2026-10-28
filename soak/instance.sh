#!/bin/bash
# Runs the ISOLATED daemon in the foreground with a scrubbed environment (env -i): HOME, XDG dirs, TMPDIR and
# the socket dir all live under SOAK_BASE, web on 127.0.0.1:SOAK_PORT. It never touches a live daemon.
# Normally started by `pilot.py start-instance` inside a systemd --user transient unit (KillMode=process).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/env.sh"

case "$SOAK_HOME" in
  "$HOME"|"$HOME/"|"") echo "refusing: SOAK_HOME must not be your real home" >&2; exit 2 ;;
esac
bun_abs="$(command -v "$BUN" 2>/dev/null || true)"
[ -x "$bun_abs" ] || { echo "bun not found (BUN=$BUN)" >&2; exit 2; }
[ -x "$SOAK_BASE/bin/claude" ] || { echo "missing $SOAK_BASE/bin/claude; run soak/setup.sh" >&2; exit 2; }
mkdir -p "$SOAK_RESULTS"
cd "$SOAK_WS" || exit 1

exec env -i \
  HOME="$SOAK_HOME" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/bash LANG=C.UTF-8 TERM=xterm-256color \
  PATH="$SOAK_BASE/bin:$(dirname "$bun_abs"):/usr/local/bin:/usr/bin:/bin" \
  XDG_RUNTIME_DIR="$SOAK_RUN" XDG_CONFIG_HOME="$SOAK_HOME/.config" XDG_DATA_HOME="$SOAK_HOME/.local/share" \
  XDG_STATE_HOME="$SOAK_HOME/.local/state" XDG_CACHE_HOME="$SOAK_HOME/.cache" TMPDIR="$SOAK_TMP" \
  CLAUDECLAW_ENV_AUTOLOAD=0 DISABLE_AUTOUPDATER=1 \
  "$bun_abs" run "$SOAK_REPO/src/index.ts" start --web >>"$SOAK_RESULTS/instance.log" 2>&1
