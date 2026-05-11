# mcp-proxy — Warm-pooled tool gateway for daemon-resident agents

## What this solves

Daemon-resident integrations accumulate in any non-trivial ClaudeClaw-Plus deployment:
voice-driven agents, RAG document systems, home-automation bridges, domain-specific
automation daemons. Each needs to invoke capabilities (an MCP tool, a database query,
a remote API) repeatedly, with low latency, under common auth and audit policies.

Without a shared substrate: N plugins × M capabilities = N×M code paths, each with its
own auth code, retry logic, and connection pool.

This PR ships the HTTP gateway and `mcp-proxy` together as a single substrate: the gateway
provides the HMAC-authenticated HTTP contract, the proxy is its first in-process consumer.
A daemon-internal plugin maintains long-lived stdio connections to configured MCP servers
and re-exposes their tools through the gateway.

Pattern: **1 gateway × N proxied servers × M consumers = N+M code paths, not N×M.**

## Latency comparison

| Path | Typical latency | Notes |
|---|---|---|
| Direct HTTP (pre-PR-42) | ~50ms | No auth, no audit trail |
| inject path (Claude in loop) | ~3000ms | 2 LLM turns + cold CLI spawn |
| mcp-proxy (this PR) | ~200ms | HTTP roundtrip + MCP stdio + tool exec |

## Architecture

```
                        ┌──────────────────────┐
                        │  claudeclaw daemon   │
                        │  port 4632           │
                        └─┬────────────────────┘
                          │
      ┌───────────────────┼─────────────────────────┐
      │                   │                         │
      ▼                   ▼                         ▼
┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ HTTP gateway │  │ mcp-proxy plugin │  │ other plugins    │
│ /api/plugin/*│←→│ (long-lived)     │  │                  │
└──────────────┘  └────────┬─────────┘  └──────────────────┘
                            │ stdio
               ┌────────────┼────────────┐
               ▼            ▼            ▼
         ┌──────────┐ ┌──────────┐ ┌──────────┐
         │ server A │ │ server B │ │ server C │
         └──────────┘ └──────────┘ └──────────┘
```

## Routing modes

Each proxied tool accepts a `mode` field:

| mode | path | latency | when to use |
|---|---|---|---|
| `direct` (default) | warm pool → MCP stdio | ~200ms | deterministic tool calls |
| `reasoned` | /api/inject → Claude | ~3000ms | tools needing planning |

Same endpoint, two paths inside. The audit log records which path was used on every call.

Decision tree:
- Tool returns deterministic JSON given the same args → `direct`
- Tool requires LLM reasoning to pick parameters or interpret results → `reasoned`
- Not sure → use `direct` first; fall back to `reasoned` if the response needs interpretation

## Configuration

**`~/.config/claudeclaw/mcp-proxy.json`**

```json
{
  "servers": {
    "home-automation": {
      "command": "node",
      "args": ["/path/to/mcp-servers/home-automation/index.js"],
      "enabled": true,
      "allowedTools": ["list_devices", "device_command", "device_status"]
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "enabled": true,
      "env": { "BRAVE_API_KEY": "your-key-here" }
    }
  }
}
```

See `mcp-proxy.json.example` in the repo root for a full template.

## Calling a proxied tool

**URL**: `POST http://localhost:4632/api/plugin/mcp-proxy/tools/{server}__{tool}/invoke`

**Auth**: HMAC with the mcp-proxy plugin token (stored at `~/.config/claudeclaw/mcp-proxy.token`).
The token is written at daemon startup.

**Body**:
```json
{
  "arguments": { "device_id": "42", "command": "on" },
  "mode": "direct"
}
```

**Response**:
```json
{ "result": { "status": "ok" }, "request_id": "abc123" }
```

## Adding a new server

1. Add an entry in `~/.config/claudeclaw/mcp-proxy.json`
2. Restart the claudeclaw daemon (`systemctl --user restart claudeclaw`)
3. Verify with: `curl http://localhost:4632/api/plugin/mcp-proxy/health`
4. Call the tool: `curl -X POST http://localhost:4632/api/plugin/mcp-proxy/tools/{server}__{tool}/invoke ...`

## Restart supervision

If an MCP server process crashes:
- Status marked `crashed`; tool invocations return an error until recovery
- Backoff: 1s → 5s → 30s → 60s (capped)
- After 5 crashes in 5 minutes: status `failed`, no further restarts until daemon restart
- Audit event `mcp_proxy_server_crashed` / `mcp_proxy_server_permanently_failed` emitted

Server stderr goes to `~/.cache/claudeclaw/mcp-proxy/{server}.log`.

## Security model

- Bootstrap token (`~/.config/plus/plugin-bootstrap.secret`, mode 0600, 32 bytes) gates initial registration.
- Per-plugin HMAC token issued at registration scopes inbound tool calls.
- 15-minute replay window prevents request replay.
- `allowedTools` per-server config narrows exposure independently of what the MCP server publishes.
- Audit log at `~/.config/plus/plugin-audit.jsonl` captures every invocation (calling plugin, target server+tool, args hash, result shape — no payload).

## Comparison with adjacent projects

### Hermes (NousResearch)

Hermes has a clean plugin registry (`registry.register(name, toolset, schema, handler, ...)`)
and supports MCP via the `mcp__<server>__<tool>` namespace. However, **Hermes treats native
plugin tools and MCP servers as two parallel systems**: a native plugin cannot register a tool
that fronts an MCP server's capability, and the two paths have separate auth, separate audit,
and separate lifecycle.

mcp-proxy collapses this duality. A single substrate carries both:
- **Plugins** register via `/api/plugin/register` with manifest + HMAC + tool schemas.
- **MCP servers** are proxied through a single plugin (`mcp-proxy`) registered under the same contract.
- Every invocation flows through the same endpoint, with the same HMAC, replay window, and audit log.

Result: one auth channel, one audit log, one observability surface.

### OpenClaw / NemoClaw / SwarmClaw

These projects share the `mcp__<server>__<tool>` tool-name convention and the plugin-manifest
contract. The mcp-proxy plugin (~200 LOC of TypeScript + `server-process.ts`) is self-contained
and can be lifted into any of these runtimes by mapping their plugin lifecycle to the manifest
contract.

## Next plugin candidates

### Retrieval / RAG daemon (reference consumer, lives outside this diff)

A retrieval daemon for RAG document search runs as an external HTTP plugin (separate repository).
It registers via `/api/plugin/register` and serves search + index-management tools. Search
latency: ~200ms via the gateway vs ~30s via prior async spawn paths. Demonstrates the substrate
supports both in-process consumers (`mcp-proxy`) and external HTTP daemons under one unified
contract.

### Voice-agent migration (follow-up PR)

Existing voice-driven agents using the `mcp_invoke` helper (POST `/api/inject` → Claude → MCP)
can switch to a `mcp_proxy_invoke` helper (POST `/api/plugin/<server>/tools/<tool>/invoke` → warm pool)
in a follow-up PR. Expected latency drop: ~3000ms → ~200ms for deterministic tool calls (home
automation, search). The migration is a 3-line helper addition plus call-site rewrites.

Out of scope of the mcp-proxy infrastructure PR by design — infrastructure first, then migrate
consumers progressively to validate the new path under real load.
