# Plugin Tool Integration Guide

ClaudeClaw-Plus exposes a `PluginMcpBridge` that lets daemon plugins register tools and expose them to the MCP ecosystem. All registered tools are served via a stdio MCP server that any MCP client (Claude Desktop, etc.) can connect to.

---

## Architecture Overview

```
Plus daemon
├── PluginManager (src/plugins.ts)
│   └── lifecycle events (gateway_start, session_start, agent_end, …)
└── PluginMcpBridge (src/plugins/mcp-bridge.ts)
    ├── registerPluginTool(pluginId, tool)  ← plugin registration API
    ├── McpServer (src/plugins/mcp-server.ts, stdio)
    ├── HMAC-SHA256 signed inter-plugin calls
    └── Append-only audit log (~/.config/plus/plugin-audit.jsonl)
```

---

## Registering Tools from a Plugin

Plugins receive a `PluginApi` object at init time. Call `api.registerTool(tool)` to register an MCP-compatible tool:

```typescript
import type { PluginInitFn } from "claudeclaw-plus/src/plugins.js";
import { z } from "zod";

const init: PluginInitFn = (api) => {
  api.registerTool({
    name: "pending",
    description: "List pending tuner proposals",
    schema: z.object({
      subject: z.string().optional(),
    }),
    handler: async (args) => {
      return engine.listPending(args.subject);
    },
  });

  api.registerTool({
    name: "apply",
    description: "Apply a tuner proposal by ID",
    schema: z.object({ id: z.string() }),
    handler: async (args) => engine.apply(args.id),
  });
};

export default init;
```

The tool is registered under the FQN `{pluginId}__{toolName}` (e.g. `skills-tuner__pending`).

---

## Pattern: Archiviste Plugin

```typescript
const init: PluginInitFn = (api) => {
  api.registerTool({
    name: "search_docs",
    description: "Full-text search across archived documents",
    schema: z.object({
      query: z.string(),
      trusted_only: z.boolean().optional(),
      limit: z.number().optional(),
    }),
    handler: async (args) => archiviste.search(args),
  });

  api.registerTool({
    name: "index_doc",
    description: "Index a new document into the archive",
    schema: z.object({
      path: z.string(),
      tags: z.array(z.string()).optional(),
    }),
    handler: async (args) => archiviste.index(args.path, args.tags),
  });
};
```

---

## Pattern: Voice Plugin (Greg)

```typescript
const init: PluginInitFn = (api) => {
  api.registerTool({
    name: "play_tts",
    description: "Synthesize and play text-to-speech audio",
    schema: z.object({
      text: z.string(),
      voice: z.string().optional(),
    }),
    handler: async (args) => voice.playTts(args.text, args.voice),
  });

  api.registerTool({
    name: "transcribe_audio",
    description: "Transcribe an audio file to text using Whisper",
    schema: z.object({ path: z.string() }),
    handler: async (args) => voice.transcribe(args.path),
  });
};
```

---

## Security

### Per-Plugin Secret

Each plugin gets a 32-byte random secret stored at:
```
~/.config/plus/plugins/<pluginId>/.secret   (mode 0600)
```

The secret is auto-created on first use and hex-encoded on disk. It never leaves the local machine.

### HMAC-SHA256 Signing

Every `invokeTool` call is signed before reaching the handler:

```typescript
const sig = bridge.signCall(pluginId, args, Date.now());
const ok  = bridge.verifyCall(pluginId, args, ts, sig);
```

Verification uses `timingSafeEqual` to prevent timing attacks.

### Zod Validation

All tool arguments are validated against the plugin-provided `schema` before the handler is called. Invalid args throw immediately and are logged to the audit log.

### Audit Log

Every `register`, `invoke`, `error` event is appended to:
```
~/.config/plus/plugin-audit.jsonl
```

Each line is a JSON object with `{ event, ts, fqn, pluginId, … }`. The file is append-only; never truncate it — it is an audit trail.

---

## Starting the MCP Server

### Standalone

```bash
bun run src/plugins/mcp-server.ts
```

The server listens on stdio and exposes all registered tools to any MCP client.

### Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or equivalent:

```json
{
  "mcpServers": {
    "claudeclaw-plus": {
      "command": "bun",
      "args": ["run", "/home/simon/Projects/ClaudeClaw-Plus/src/plugins/mcp-server.ts"]
    }
  }
}
```

---

## Direct Bridge Access (Advanced)

If you need to register tools outside of the Plugin lifecycle, import the singleton directly:

```typescript
import { getMcpBridge } from "claudeclaw-plus/src/plugins/mcp-bridge.js";
import { z } from "zod";

const bridge = getMcpBridge();

bridge.registerPluginTool("my-service", {
  name: "status",
  description: "Get service status",
  schema: z.object({}),
  handler: async () => ({ ok: true }),
});
```

---

## Per-subject git repositories in skills-tuner

The skills-tuner plugin (#41) uses `engine.applyProposal()` to apply proposals. The engine routes each `applyProposal()` call to the subject's configured `git_repo` in `~/.config/tuner/config.yaml`.

> Subjects can target different git repos. The MCP bridge plugin tools (#42) call back to `engine.applyProposal()` which routes to the subject's configured `git_repo`. This means an external Python plugin (Greg, archiviste) can apply proposals into its own repo, isolated from skills.

Example: if `trader-ml-hp` subject has `git_repo: ~/Projects/momentum_trader_v7`, then tuner proposals for that subject commit into the trader repo — not the skills repo. Each subject has its own rollback path.

---

## Running Tests

```bash
bun test src/__tests__/plugins/mcp-bridge.test.ts
```

All 8+ assertions cover: registration, duplicates, zod validation, HMAC round-trips, audit log entries, and secret management.
