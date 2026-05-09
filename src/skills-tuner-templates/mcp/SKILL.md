---
name: mcp
description: Manage the ClaudeClaw-Plus MCP bridge — register plugins, monitor health, audit invocations, debug cross-process calls, generate plugin templates. Use when configuring/troubleshooting the plugin gateway, when adding a new daemon plugin (Greg, archiviste, ML pipelines), when investigating audit log events, or when diagnosing plugin connectivity issues.
---

# MCP — Plus plugin gateway companion skill

Multi-mode skill for the ClaudeClaw-Plus MCP bridge (#42). Connects to Plus's HTTP gateway at `http://localhost:3000/api/plugin/*` and the audit log at `~/.config/plus/plugin-audit.jsonl`.

## Mode dispatch

Read user intent from the trigger / first message:

- `/mcp` (no arg) or first-time use → **setup**
- `/mcp list` or "what plugins are registered" → **list**
- `/mcp inspect <plugin>` or "tell me about <plugin>" → **inspect**
- `/mcp diagnose` or "are my plugins healthy" → **diagnose**
- `/mcp audit` or "show recent plugin events" → **audit**
- `/mcp trace <request_id>` or "find this request" → **trace**
- `/mcp register` or "add a new plugin" → **register**
- `/mcp test <plugin> <tool>` or "test <plugin>'s <tool>" → **test**
- `/mcp report` or "this looks like an MCP bug" → **report**

If unclear, ask.

---

## Mode: setup

Goal: prepare a new plugin install — print bootstrap token, walk through Plus config, suggest first plugin registration.

### Step 1 — Welcome

Tell the user in 3 sentences:
1. The MCP bridge lets daemon-style plugins (Python, Rust, etc.) register tools that Claude Code can call.
2. Each plugin needs a bootstrap token (one-time) and a per-plugin secret (auto-generated at register).
3. The bridge runs HTTP endpoints under `/api/plugin/*` and an MCP server at `bun run src/plugins/mcp-server.ts`.

### Step 2 — Print bootstrap token

```bash
bun run src/plugins/cli.ts print-bootstrap-token
```

If file doesn't exist (first run), Plus auto-creates it at `~/.config/plus/plugin-bootstrap.secret` (0600, 32 bytes). Display the token to the user. Tell them:

> Save this token — your plugin install scripts need it for the `register` call. You can re-print it any time with the same command.

### Step 3 — Verify Plus is running

```bash
curl -s http://localhost:3000/api/plugin/list
```

If 404 / connection refused → Plus daemon not running with `--web` flag. Suggest restart:
```bash
systemctl --user restart claudeclaw.service
```

If returns `{"plugins": []}` → bridge is up, no plugins yet.

### Step 4 — Suggest next steps

> Ready to register your first plugin?
>   1. Generate a Python plugin template (`/mcp register`)
>   2. Manual: see `docs/plugin-integration.md` for examples (Greg/voice, archiviste)
>   3. Skip (already have a plugin scripted)

End setup.

---

## Mode: list

Goal: show all registered plugins with their health status.

### Step 1 — Fetch list

```bash
curl -s http://localhost:3000/api/plugin/list
```

### Step 2 — Render table

```
Registered plugins:

| Plugin       | Version | Tools                          | Health | Registered |
|--------------|---------|--------------------------------|--------|------------|
| skills-tuner | 0.1.0   | pending, apply, refuse         | ✅ ok  | 2h ago     |
| greg-voice   | 1.0.0   | send_tts, transcribe_audio     | ⚠️ deg | 2d ago     |
| archiviste   | 2.1.0   | search_docs, index_doc         | ❌ down| 5d ago     |
```

For health:
- ✅ ok — last_health_check.healthy = true within last 5 min
- ⚠️ degraded — healthy but slow (>1s response) or stale check (>10 min)
- ❌ down — last_health_check.healthy = false or no manifest health_url
- ❓ unknown — no health_url declared

### Step 3 — Suggest next actions

If any ❌ or ⚠️:
> Run `/mcp inspect <plugin>` for details, or `/mcp diagnose` to refresh health checks.

End list.

---

## Mode: inspect <plugin>

Goal: deep dive on one plugin.

### Step 1 — Fetch plugin info

```bash
curl -s http://localhost:3000/api/plugin/list | jq '.plugins[] | select(.name == "<plugin>")'
```

### Step 2 — Force health check

```bash
curl -s http://localhost:3000/api/plugin/<plugin>/health
```

### Step 3 — Show recent audit events for this plugin

Read `~/.config/plus/plugin-audit.jsonl`, filter by `plugin == "<plugin>"`, last 20 entries.

### Step 4 — Render report

```
## Plugin: greg-voice

### Manifest
- Version: 1.0.0 (schema_version 1)
- Capabilities: tools
- Callback: http://localhost:8765/plus-callback
- Health: http://localhost:8765/health
- Tools: send_tts, transcribe_audio

### Health
- Last check: 2 min ago — degraded (response time 1.4s, target <500ms)
- HTTP: 200 OK

### Recent activity (last 20)
- 14:32:18 invoke tool=send_tts request_id=abc123 (success, 312ms)
- 14:31:50 invoke tool=transcribe_audio request_id=def456 (success, 1.2s)
- 14:30:12 health_check (healthy)
- ...

### Suggested actions
- Investigate slow responses (1.2s on transcribe vs target 500ms)
- Run `/mcp test greg-voice send_tts` to verify functionality
```

End inspect.

---

## Mode: diagnose

Goal: full health sweep + config validation.

### Step 1 — Check Plus is running

```bash
curl -fsS http://localhost:3000/api/plugin/list > /dev/null || echo "Plus daemon down"
```

### Step 2 — Check bootstrap token exists

```bash
ls -la ~/.config/plus/plugin-bootstrap.secret
```

Verify perms 0600. If missing, suggest `bun run src/plugins/cli.ts print-bootstrap-token` to auto-create.

### Step 3 — Health check all plugins

For each plugin in list:
```bash
curl -s http://localhost:3000/api/plugin/<name>/health
```

### Step 4 — Audit log recent errors

Read last 100 entries from `plugin-audit.jsonl`. Filter for `event` containing `error`, `failed`, `denied`, `mismatch`.

### Step 5 — Render report

```
## Diagnose report — 2026-05-10 14:35

### Daemon
✅ Plus daemon responding on :3000
✅ Bootstrap token present (0600 perms)
✅ Bridge initialized (3 plugins registered)

### Per-plugin health
- skills-tuner: ✅ ok
- greg-voice:   ⚠️ degraded (slow callback)
- archiviste:   ❌ down (connection refused on :9090)

### Recent errors (last 100 audit entries)
- 14:30:12 archiviste search_docs invoke_failed (callback unreachable, 5 occurrences)
- 14:25:33 greg-voice send_tts invalid_args (zod error: missing 'text' field)

### Recommendations
1. archiviste: process not running. Start with `systemctl --user start archiviste.service`.
2. greg-voice: caller passing invalid args — check Greg's callback handler validation.
```

End diagnose.

---

## Mode: audit [filter]

Goal: tail recent plugin-audit.jsonl events with optional filter.

### Step 1 — Read audit log

```bash
tail -200 ~/.config/plus/plugin-audit.jsonl | jq -c .
```

### Step 2 — Filter

If user provided keyword (e.g. `audit error`, `audit greg-voice`, `audit invoke_failed`):
- Filter entries by event matching keyword OR plugin matching keyword.

### Step 3 — Group + render

Group by event type, show counts + sample entries. Highlight security-relevant events: `invalid_signature`, `stale_or_future_timestamp`, `capability_denied`, `callback_host_not_allowed`.

```
## Audit summary — last 200 entries

By event type:
- tool_invoked × 142
- tool_success × 138
- tool_error × 4 (3 archiviste callback_unreachable, 1 greg invalid_args)
- http_plugin_registered × 3
- invalid_signature × 0 ✅
- stale_or_future_timestamp × 0 ✅

Security-relevant entries: 0 (audit healthy)

Recent errors:
14:30:12 archiviste tool_error: callback unreachable (request_id=abc789)
14:25:33 greg-voice tool_error: zod validation (request_id=def012)
```

### Step 4.5 — Drift since last cron

Check `~/.config/tuner/state-hashes.jsonl` for recent `subject_state_drift_detected` entries with `subject == "mcp"` (if `MCPSubject` is implemented) or related plugin subjects.

If MCPSubject not yet implemented, note:
> Drift detection for MCP plugins requires a future `MCPSubject` implementation. Manual `/mcp audit` invocation surfaces current state — automatic drift between audits will land when MCPSubject is added and `currentStateHash()` is implemented to hash `/api/plugin/list`.

End audit.

---

## Mode: trace <request_id>

Goal: follow a request_id through audit log + plugin health to debug intermittent issues.

### Step 1 — Find all entries with that request_id

```bash
grep -E "\"request_id\":\"<id>\"" ~/.config/plus/plugin-audit.jsonl | jq -c .
```

### Step 2 — Sequence them chronologically

### Step 3 — Annotate timeline

```
## Trace: request_id=abc789

[14:30:10.123] http_invoke_received (skills-tuner__pending args=...)
[14:30:10.125] tool_invoked plugin=skills-tuner tool=pending
[14:30:10.128] tool_success duration_ms=3 (returned 4 proposals)
[14:30:10.130] http_response_sent status=200

Total: 7ms end-to-end. ✅ Clean.
```

If trace shows error chain, surface it:
```
[14:25:33.450] http_invoke_received (greg-voice__send_tts args=...)
[14:25:33.451] tool_invoked plugin=greg-voice tool=send_tts
[14:25:33.452] tool_error error="zod validation: 'text' is required"

Root cause: caller passed empty args. Check greg-voice client code.
```

End trace.

---

## Mode: register

Goal: interactive wizard — create a new plugin manifest and (optionally) scaffold plugin code.

### Step 1 — Plugin name

Prompt: "What's the plugin name? (lowercase, kebab-case)"

Validate: matches `^[a-z][a-z0-9-]*$`.

### Step 2 — Callback URL

Prompt: "Where will Plus call your plugin? (default: http://localhost:8765/plus-callback)"

Default `localhost:NNNN`. If non-localhost, warn user about allowlist requirement.

### Step 3 — Tools

Prompt loop: "Add a tool? (name + description, or 'done')"

For each tool: name, description, args schema (simple — type + required fields).

### Step 4 — Capabilities

Prompt: "Capabilities: tools (default), hooks, session_read, session_write?" Default tools.

### Step 5 — Generate

Two outputs:

**a. Manifest JSON** for the user to POST:
```json
{
  "name": "<name>",
  "version": "0.1.0",
  "schema_version": 1,
  "callback_url": "http://localhost:8765/plus-callback",
  "tools": [...],
  "capabilities": ["tools"]
}
```

**b. Python plugin scaffold** (in `~/agent/plugins/<name>/server.py`):
```python
import requests, hmac, hashlib, json
from http.server import BaseHTTPRequestHandler, HTTPServer

PLUGIN_TOKEN = "<set after register>"

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        # Verify HMAC ...
        # Dispatch by tool name ...
        # Return JSON {result: ...}
        pass

if __name__ == '__main__':
    HTTPServer(('localhost', 8765), Handler).serve_forever()
```

### Step 6 — Register

If user confirms, do the POST:
```bash
BOOTSTRAP=$(bun run src/plugins/cli.ts print-bootstrap-token)
curl -X POST http://localhost:3000/api/plugin/register \
  -H "Authorization: Bearer $BOOTSTRAP" \
  -H "Content-Type: application/json" \
  -d @manifest.json
```

Save returned `plugin_token` to `~/.config/plus/plugins/<name>/.secret` (0600).

End register.

---

## Mode: test <plugin> <tool>

Goal: invoke a tool with sample args to verify functionality.

### Step 1 — Get tool schema

From plugin's manifest in `/api/plugin/list`.

### Step 2 — Build args

Prompt user for required fields, with sensible defaults shown. Reject invalid types.

### Step 3 — Sign + invoke

Generate HMAC + ts, POST to `/api/plugin/<name>/tools/<tool>/invoke`. Show response, audit entry, request_id.

### Step 4 — Show result

Pretty-print result + suggest follow-up if error (rerun with different args, check `/mcp inspect`).

End test.

---

## Mode: report

Goal: file a sanitized upstream issue if MCP bridge has a real bug.

Same flow as `tuner report` mode (see tuner.md):
1. User describes the symptom
2. Categorize (Critical / Perf / Detection / Doc)
3. Sanitize logs (paths, IPs, tokens)
4. Show draft, ask Post Now / Edit / Cancel
5. POST via `gh issue create --repo TerrysPOV/ClaudeClaw-Plus --label mcp-report`

End report.

---

## Self-improvement notes (for the framework that watches this skill)

Like the `tuner` skill, this `mcp` skill lives in the user's tunable surface and is itself a `TunableSubject` member. Frequent confusion or correction patterns on `/mcp` invocations would trigger framework proposals to refine these modes.

Special safeguards (same as tuner):
- `risk_tier: critical` (config override) — never auto-merge changes
- 30-day cool-down between accepted self-modifications
- Diff-mandatory on proposals
- Audit log entries tagged `event: meta_mcp_self_modify`

If you (Claude Code, reading this skill) are asked to modify mcp.md itself, surface the safeguards explicitly to the user before applying.

---

## Closing note

If you're unsure which mode applies, say so and ask the user. Modes can be combined (`/mcp list` then `/mcp inspect <picked>`) — sequential, not nested. The bridge endpoints are localhost-only by default — if user reports "can't reach plugin", first check that Plus daemon runs `--web` on :3000.
