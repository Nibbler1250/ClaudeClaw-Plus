#!/bin/bash
# Creates (or refreshes) the isolated install under SOAK_BASE. Idempotent: re-running keeps the generated
# apiToken, the isolated credentials and any session state, and rewrites only the harness-owned config.
# It never writes outside SOAK_BASE; the live credentials file is only read.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/env.sh"

die() { echo "setup: $*" >&2; exit 1; }

real_home="$(cd "$HOME" && pwd -P)"
for d in "$SOAK_BASE" "$SOAK_HOME"; do
  [ -n "$d" ] || die "empty path"
  case "$(realpath -m "$d")" in "$real_home"|"/") die "refusing: $d is your real home or /";; esac
done

# requirements
[ "$(uname -s)" = Linux ] || echo "setup: warning: the pilot reads /proc and only runs on Linux (see README)" >&2
command -v "$BUN" >/dev/null 2>&1 || die "bun not found (set BUN)"
[ -n "$SOAK_CLAUDE_BIN" ] && [ -x "$SOAK_CLAUDE_BIN" ] || die "claude CLI not found (set SOAK_CLAUDE_BIN)"
command -v systemd-run >/dev/null 2>&1 || die "systemd-run not found (the pilot runs the instance in a systemd --user unit)"
ver="$("$SOAK_CLAUDE_BIN" --version 2>/dev/null | awk '{print $1}')"
min=2.1.304
if [ "$(printf '%s\n%s\n' "$min" "$ver" | sort -V | head -1)" != "$min" ]; then
  die "claude $ver is older than $min"
fi
[ -d "$SOAK_REPO/src" ] || die "SOAK_REPO=$SOAK_REPO has no src/"
[ -d "$SOAK_REPO/node_modules" ] || echo "setup: warning: run 'bun install' in $SOAK_REPO before starting the instance" >&2

# directories
mkdir -p "$SOAK_BASE/bin" "$SOAK_RESULTS" "$SOAK_BASE/trigger" "$SOAK_WS/.claude/claudeclaw/jobs" "$SOAK_TMP"
mkdir -p -m 700 "$SOAK_HOME" "$SOAK_HOME/.claude" "$SOAK_RUN"
ln -sfn "$SOAK_CLAUDE_BIN" "$SOAK_BASE/bin/claude"
chmod +x "$here/mcp/fake_mcp.py"

export SETUP_CLAUDE_VERSION="$ver"
/usr/bin/env python3 -I - <<'PY'
import json, os, secrets
from pathlib import Path

E = os.environ
ws, home, repo = Path(E["SOAK_WS"]), Path(E["SOAK_HOME"]), Path(E["SOAK_REPO"])
mcp = repo / "soak" / "mcp"


def write(path, obj, mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name("." + path.name + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2) + "\n")
    if mode is not None:
        os.chmod(tmp, mode)
    tmp.replace(path)


def load(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


# 1. project MCP servers: one normal, one slow to exit, one deaf to SIGTERM
write(ws / ".mcp.json", {"mcpServers": {
    "soak-ok": {"type": "stdio", "command": str(mcp / "mcp-ok"), "args": []},
    "soak-slow": {"type": "stdio", "command": str(mcp / "mcp-slow"), "args": []},
    "soak-deaf": {"type": "stdio", "command": str(mcp / "mcp-deaf"), "args": []},
}})

# 2. daemon settings (keeps an existing apiToken; pty.groupConfirm left at its default)
sp = ws / ".claude" / "claudeclaw" / "settings.json"
s = load(sp)
s["web"] = {"enabled": True, "host": "127.0.0.1", "port": int(E["SOAK_PORT"])}
s["apiToken"] = s.get("apiToken") or secrets.token_urlsafe(32)
s["timezone"] = E.get("SOAK_TZ") or "UTC"
s["agents"] = [{"id": "default"}]
s["plugins"] = {"soak-trigger": {"enabled": True, "source": str(repo / "soak" / "plugin"), "config": {
    "triggerDir": str(Path(E["SOAK_BASE"]) / "trigger"),
    "outDir": str(Path(E["SOAK_RESULTS"]) / "plugin"),
    "repoSrc": str(repo / "src"),
}}}
s.setdefault("oneShot", {})["routes"] = {"discord.classifier": "pty", "tuner.*": "pty", "memory.recall": "pty"}
write(sp, s, 0o600)

# 3. isolated claude user settings: project MCP servers enabled without a prompt, no auto-update
hs = home / ".claude" / "settings.json"
h = load(hs)
h.setdefault("env", {})["DISABLE_AUTOUPDATER"] = "1"
h.update({"autoUpdates": False, "skipDangerousModePermissionPrompt": True, "enableAllProjectMcpServers": True})
write(hs, h)

# 4. isolated claude state: onboarding done, workspace trusted (the PTY must not land on a first-run screen)
cj = home / ".claude.json"
c = load(cj)
c["hasCompletedOnboarding"] = True
c.setdefault("lastOnboardingVersion", E.get("SETUP_CLAUDE_VERSION") or "")
projects = c.setdefault("projects", {})
for p in (ws, ws / "agents" / "default", repo):
    projects.setdefault(str(p), {})["hasTrustDialogAccepted"] = True
write(cj, c, 0o600)
PY

# 5. two haiku cron jobs (*/6 and 3-59/6), nonce prompts; the pilot rewrites them with a fresh nonce per run
python3 -I "$here/pilot.py" write-jobs

# 6. access token copied once (refresh token never copied); the pilot re-copies on mtime change during a run
if [ -r "$SOAK_LIVE_CREDENTIALS" ]; then
  python3 -I "$here/pilot.py" credsync || echo "setup: warning: credential copy failed" >&2
else
  echo "setup: warning: $SOAK_LIVE_CREDENTIALS not readable; put a logged-in credentials file in $SOAK_HOME/.claude/" >&2
fi

echo "setup: isolated install ready under $SOAK_BASE (web 127.0.0.1:$SOAK_PORT, claude $ver)"
