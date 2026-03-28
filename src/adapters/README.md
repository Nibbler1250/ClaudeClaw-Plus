# Adapter Architecture

This document defines the adapter architecture and control-plane boundaries for ClaudeClaw channel integrations.

**Status:** Architecture documentation for current and future adapters.  
**Version:** 1.0  
**Last Updated:** 2026-03-28

---

## Overview

Adapters are transport/platform boundary components that bridge external messaging platforms (Telegram, Discord, Slack, Teams, Email, GitHub) with ClaudeClaw's internal event processing pipeline.

Adapters do **not** implement business logic. They only:
- Receive platform-specific events
- Normalize events into a common schema
- Submit normalized events to the gateway
- Send outbound replies/messages back to the platform

---

## Architectural Boundaries

### What Adapters Do

| Responsibility | Description |
|----------------|-------------|
| **Inbound Reception** | Receive events from the platform (webhooks, WebSocket, polling, etc.) |
| **Normalization** | Transform platform events into `NormalizedEvent` schema |
| **Gateway Submission** | Submit normalized events to the Session Gateway |
| **Outbound Delivery** | Send replies/messages to platform channels/threads |
| **Capability Declaration** | Advertise platform capabilities (threading, attachments, etc.) |
| **Lifecycle Management** | Initialize, start, stop cleanly; report health status |

### What Adapters Must NOT Do

| Forbidden Action | Why |
|------------------|-----|
| **Invent session IDs** | Session mapping is owned by the gateway's resume module |
| **Bypass the gateway** | Never call runner.ts or processors directly; always route through gateway |
| **Implement business logic** | No policy decisions, no command parsing, no workflow orchestration |
| **Store durable state** | Session state, turn counts, and sequence numbers belong in gateway |
| **Duplicate gateway responsibilities** | Adapters are not mini-gateways; they are thin transport shims |
| **Handle cross-platform routing** | Gateway owns routing; adapters only handle their own platform |
| **Make auth decisions** | Adapters validate platform signatures/tokens but don't implement ACLs |

---

## Data Flow

### Inbound Flow

```
┌─────────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌──────────┐
│  Platform Event │ ──▶ │   Adapter   │ ──▶ │ Normalizer  │ ──▶ │   Gateway   │ ──▶ │ Event Log│
│  (Telegram,     │     │  (receive)  │     │  (transform)│     │  (admit)    │     │ (persist)│
│   Discord, etc) │     │             │     │             │     │             │     │          │
└─────────────────┘     └─────────────┘     └─────────────┘     └─────────────┘     └──────────┘
                                                                         │
                                                                         ▼
                                                                  ┌─────────────┐
                                                                  │   Session   │
                                                                  │   Mapping   │
                                                                  └─────────────┘
```

**Step-by-step:**

1. **Platform Event** — External platform delivers event (webhook POST, WebSocket message, etc.)
2. **Adapter Receives** — Adapter extracts raw platform payload
3. **Normalization** — Adapter transforms platform event into `NormalizedEvent`:
   - Maps platform IDs to `channelId` and `threadId`
   - Extracts text content and attachments
   - Preserves source metadata (message IDs for dedupe/replay)
4. **Gateway Admission** — Adapter submits normalized event to gateway
5. **Session Mapping** — Gateway resolves `channelId` + `threadId` to session
6. **Event Log** — Gateway appends event with assigned sequence number
7. **Processing** — Event processor picks up persisted event

### Outbound Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────────┐
│   Gateway   │ ──▶ │   Router    │ ──▶ │   Adapter   │ ──▶ │  Platform   │ ──▶ │   User/Channel  │
│  (routing)  │     │ (target res)│     │   (send)    │     │    API      │     │                 │
└─────────────┘     └─────────────┘     └─────────────┘     └─────────────┘     └─────────────────┘
```

**Step-by-step:**

1. **Gateway Routing** — Gateway determines reply target from session context
2. **Target Resolution** — Adapter resolves gateway target to platform-specific IDs:
   - `channelId` → platform chat/channel ID
   - `threadId` → platform thread/conversation ID
3. **Adapter Send** — Adapter calls platform API to deliver message
4. **Platform Delivery** — Platform delivers message to user/channel

---

## Lifecycle Responsibilities

### Initialize

Called once at system startup:
- Load configuration and credentials
- Validate environment variables
- Set up platform API clients
- Register webhook endpoints (if applicable)
- Validate connectivity (optional health check)

### Start

Called to begin receiving events:
- Start webhook listener (HTTP server)
- Connect WebSocket (for real-time platforms)
- Start polling loop (if applicable)
- Begin emitting normalized events to gateway

### Stop

Called for graceful shutdown:
- Stop accepting new events
- Close WebSocket connections
- Drain in-flight events
- Clean up resources

### Health & Capabilities

Adapters must expose:
- **Health status** — Is the adapter currently functional?
- **Capabilities** — What features does this platform support?
  - Threading model
  - Attachment types
  - Inbound mode (webhook/socket/polling)
  - Public webhook requirement
  - Rate limit characteristics

---

## NormalizedEvent Schema

Adapters transform platform events into this common schema:

```typescript
interface NormalizedEvent {
  id: string;                    // Assigned by event log (empty at normalization)
  channel: Channel;              // "telegram" | "discord" | "slack" | "teams" | "email" | "github"
  sourceEventId?: string;        // Platform's message/event ID
  channelId: string;             // Platform-specific channel/chat identifier
  threadId: string;              // Thread/conversation identifier
  userId: string;                // Sender identifier
  text: string;                  // Message text content
  attachments: Attachment[];     // Files, images, voice, etc.
  timestamp: number;             // Event timestamp (ms since epoch)
  metadata: {
    replyTo?: string;            // ID of message being replied to
    command?: string;            // Detected command (e.g., "/start")
    entities?: unknown[];        // Mentions, URLs, etc.
    rawType?: string | number;   // Platform-specific type
    [key: string]: unknown;      // Platform-specific extras
  };
}
```

See `src/gateway/normalizer.ts` for current implementation.

---

## Capability Model

Different platforms support different features. Adapters declare capabilities so the gateway and outbound logic can reason about platform differences.

### Capability Matrix

See `contracts.md` for the complete capability matrix comparing all adapters.

Key capabilities:

| Capability | Description |
|------------|-------------|
| `supportsThreads` | Platform has native threading/conversation model |
| `supportsDirectMessages` | Platform supports 1:1 direct messages |
| `supportsChannelMessages` | Platform supports group/channel messages |
| `supportsMessageEdit` | Platform allows editing sent messages |
| `supportsAttachments` | Platform supports file/image/voice attachments |
| `supportsReactions` | Platform supports emoji reactions |
| `supportsRichCards` | Platform supports structured cards/Adaptive Cards |
| `supportsWebhooks` | Platform supports webhook-based inbound events |
| `supportsSocket` | Platform supports WebSocket real-time events |
| `supportsPolling` | Platform supports polling-based inbound events |
| `requiresPublicWebhook` | Adapter needs publicly accessible URL for webhooks |

---

## Configuration

Adapters are configured via environment variables. See `configuration.md` for:
- Environment variable conventions
- Per-adapter configuration examples
- Secrets handling patterns
- Public webhook vs socket/polling tradeoffs

---

## Current Adapters

| Adapter | Status | Location |
|---------|--------|----------|
| **Telegram** | Implemented | `src/commands/telegram.ts` |
| **Discord** | Implemented | `src/commands/discord.ts` |

## Future Adapters

| Adapter | Status | Location |
|---------|--------|----------|
| **Slack** | Scaffolded | `src/adapters/slack/README.md` |
| **Teams** | Scaffolded | `src/adapters/teams/README.md` |
| **Email** | Scaffolded | `src/adapters/email/README.md` |
| **GitHub** | Scaffolded | `src/adapters/github/README.md` |

**Note:** Future adapters are documented and scaffolded but not yet implemented. See per-adapter READMEs for implementation guidance.

---

## Integration Points

### With Session Gateway (Phase 2)
- Adapters normalize inbound events before gateway admission
- Gateway routes outbound messages to appropriate adapter
- Adapters respect session mapping and thread context from gateway

### With Policy Engine (Phase 3)
- Future adapter actions enter policy evaluation through gateway
- Adapters do not bypass policy-governed execution paths

### With Cost Governance (Phase 4)
- Future adapters may need rate-limit-aware behavior
- Documented rate limits help inform governance decisions

### With Orchestration (Phase 5)
- Future adapters may reflect orchestration state in replies
- Handoff/resume flows may surface over these adapters

### With Human Escalation (Phase 6)
- Future escalation notifications may deliver through some adapters
- Document notes indicate which platforms suit escalation alerts

---

## Best Practices

1. **Keep adapters thin** — Normalize and delegate; don't implement business logic
2. **Preserve provenance** — Always capture source event IDs for dedupe and replay
3. **Declare capabilities honestly** — Don't claim support for features the platform lacks
4. **Handle platform quirks** — Document platform-specific behavior in adapter README
5. **Fail gracefully** — If gateway is unavailable, queue or error cleanly; don't lose events
6. **Validate signatures** — Always verify webhook signatures to prevent spoofing
7. **Respect rate limits** — Document platform rate limits; implement backoff when possible

---

## See Also

- [`contracts.md`](./contracts.md) — Adapter contracts and capability matrix
- [`configuration.md`](./configuration.md) — Configuration patterns and examples
- `src/gateway/normalizer.ts` — NormalizedEvent schema and transformers
- `src/gateway/index.ts` — Gateway orchestrator implementation
