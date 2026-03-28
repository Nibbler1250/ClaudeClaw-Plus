# Adapter Contracts

This document defines the adapter contract, normalized event semantics, and capability matrix for all ClaudeClaw channel integrations.

**Status:** Contract documentation for current and future adapters.  
**Version:** 1.0  
**Last Updated:** 2026-03-28

---

## Adapter Contract Interface

The recommended adapter contract reflects the gateway/session/normalization model. Adapters may implement a subset of these methods depending on platform capabilities.

```typescript
interface ChannelAdapter {
  /** Adapter identifier (e.g., "slack", "teams") */
  name: string;

  // --- Lifecycle ---

  /** Initialize credentials, config, and resources */
  initialize(): Promise<void>;

  /** Start receiving inbound events (webhook, socket, polling) */
  start(): Promise<void>;

  /** Stop receiving inbound events cleanly */
  stop(): Promise<void>;

  // --- Capabilities ---

  /** Return adapter capabilities for gateway/outbound logic */
  getCapabilities(): AdapterCapabilities;

  // --- Inbound ---

  /** Convert platform event into normalized inbound event */
  normalizeInboundEvent(platformEvent: unknown): NormalizedEvent;

  // --- Outbound ---

  /** Send or reply to a thread/conversation on the platform */
  sendMessage(
    target: OutboundMessageTarget,
    content: OutboundMessageContent
  ): Promise<AdapterSendResult>;

  /** Edit/update a message (optional, if platform supports) */
  editMessage?(
    target: OutboundMessageTarget,
    content: OutboundMessageContent
  ): Promise<AdapterSendResult>;

  /** Delete a message (optional, if platform supports) */
  deleteMessage?(
    target: OutboundMessageTarget
  ): Promise<AdapterSendResult>;
}
```

### Capability Declaration

```typescript
interface AdapterCapabilities {
  /** Platform supports threaded conversations */
  supportsThreads: boolean;

  /** Platform supports 1:1 direct messages */
  supportsDirectMessages: boolean;

  /** Platform supports group/channel messages */
  supportsChannelMessages: boolean;

  /** Platform allows editing sent messages */
  supportsMessageEdit?: boolean;

  /** Platform supports file/image/voice attachments */
  supportsAttachments?: boolean;

  /** Platform supports emoji reactions */
  supportsReactions?: boolean;

  /** Platform supports structured cards/Adaptive Cards */
  supportsRichCards?: boolean;

  /** Platform supports webhook-based inbound events */
  supportsWebhooks?: boolean;

  /** Platform supports WebSocket real-time events */
  supportsSocket?: boolean;

  /** Platform supports polling-based inbound events */
  supportsPolling?: boolean;

  /** Adapter needs publicly accessible URL for webhooks */
  requiresPublicWebhook?: boolean;

  /** Platform requires specific auth model (oauth, token, etc.) */
  authModel?: "token" | "oauth" | "oauth2" | "jwt" | "signature";

  /** Known rate limit (requests per minute, 0 = unknown/unlimited) */
  rateLimitRpm?: number;
}
```

### Outbound Target Model

```typescript
interface OutboundMessageTarget {
  /** Source channel identifier (e.g., "slack", "teams") */
  source: string;

  /** Platform-specific channel/chat ID */
  channelId?: string;

  /** Thread/conversation ID */
  threadId?: string;

  /** User ID for DM replies */
  userId?: string;

  /** Specific message ID to reply to */
  replyToMessageId?: string;
}

interface OutboundMessageContent {
  /** Plain text content (required) */
  text: string;

  /** Optional structured content (platform-dependent) */
  blocks?: unknown[];

  /** Optional attachments */
  attachments?: Attachment[];

  /** Optional metadata for platform-specific features */
  metadata?: Record<string, unknown>;
}

interface AdapterSendResult {
  /** Whether the send was successful */
  success: boolean;

  /** Platform's message ID (for tracking/editing) */
  messageId?: string;

  /** Timestamp of send */
  timestamp?: number;

  /** Error message if failed */
  error?: string;
}
```

---

## Normalized Event Semantics

### Inbound Normalization

Adapters transform platform-specific events into `NormalizedEvent`:

| Field | Semantics | Example Values |
|-------|-----------|----------------|
| `id` | Assigned by event log (empty at normalization) | `""` → `"evt_abc123"` |
| `channel` | Channel type discriminator | `"telegram"`, `"discord"`, `"slack"` |
| `sourceEventId` | Platform's native event/message ID | `"123456789"` (Telegram) |
| `channelId` | Unique channel/chat identifier | `"telegram:123456"`, `"discord:guild:abc:def"` |
| `threadId` | Thread/conversation within channel | `"default"`, `"thread_abc123"` |
| `userId` | Sender identifier | `"987654321"` |
| `text` | Message text content | `"Hello world"` |
| `attachments` | Array of file attachments | `[{ type: "image", url: "..." }]` |
| `timestamp` | Event timestamp (ms since epoch) | `1711627200000` |
| `metadata.replyTo` | ID of message being replied to | `"123456"` |
| `metadata.command` | Detected command (e.g., "/start") | `"/start"` |
| `metadata.entities` | Platform-specific entities | Mentions, URLs, etc. |

### Channel ID Conventions

Different platforms use different ID schemes. Adapters should use consistent prefixes:

| Platform | channelId Format | Example |
|----------|------------------|---------|
| Telegram | `telegram:{chat.id}` | `telegram:123456789` |
| Discord | `discord:guild:{guild_id}:{channel_id}` | `discord:guild:abc:def` |
| Discord DM | `discord:dm:{channel_id}` | `discord:dm:abc123` |
| Slack | `slack:{team_id}:{channel_id}` | `slack:T123:C456` |
| Teams | `teams:{tenant_id}:{conversation_id}` | `teams:abc-123:conv-456` |
| Email | `email:{mailbox}` | `email:support@example.com` |
| GitHub | `github:{owner}/{repo}` | `github:org/repo` |

### Thread ID Semantics

| Platform | Thread Model | threadId Value |
|----------|--------------|----------------|
| Telegram | Topics (optional) | `message_thread_id` or `"default"` |
| Discord | Thread channels | `channel_id` (thread = channel) |
| Slack | Thread_ts | `thread_ts` value or `"default"` |
| Teams | Conversation ID | `conversation.id` |
| Email | Message-ID chain | Thread hash from References |
| GitHub | Issue/PR number | `issue_42` or `pr_123` |

---

## Capability Matrix

| Capability | Telegram | Discord | Slack | Teams | Email | GitHub |
|------------|----------|---------|-------|-------|-------|--------|
| **Inbound Mode** | Webhook | WebSocket | Events API / Socket | Webhook | IMAP/Poll | Webhook |
| **Threading** | Topics | Threads | thread_ts | Conversations | Headers | Issue/PR # |
| **Outbound Reply** | reply_to_message_id | message_reference | thread_ts | replyToId | In-Reply-To | Comment API |
| **DM Support** | ✅ | ✅ | ✅ | ✅ | ✅ (email) | ❌ |
| **Channel Support** | ✅ | ✅ | ✅ | ✅ | ✅ (list) | ❌ (repo-scoped) |
| **Message Edit** | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Attachments** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (limited) |
| **Reactions** | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ (reactions) |
| **Rich Cards** | ✅ (HTML) | ✅ (embeds) | ✅ (blocks) | ✅ (Adaptive) | ❌ | ✅ (markdown) |
| **Webhook Support** | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |
| **Socket Support** | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Polling Support** | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| **Public Webhook Req** | ✅ | ❌ | Optional | ✅ | ❌ | ✅ |
| **Auth Model** | Token | Token | OAuth + Token | OAuth | Password/Token | JWT + Signature |
| **Rate Limit (RPM)** | ~30 | ~50 | ~100+ | ~100 | N/A | ~60-5000 |

### Detailed Comparison

#### Telegram
- **Inbound:** Webhook (via Bot API setWebhook)
- **Threading:** Topics via `message_thread_id` (optional)
- **Auth:** Bot token (long-lived)
- **Signature:** None (token-based auth)
- **Rate Limits:** ~30 messages/second burst, sustained lower
- **Special Notes:** File downloads require separate getFile call

#### Discord
- **Inbound:** WebSocket Gateway (real-time)
- **Threading:** Thread channels (separate channel object)
- **Auth:** Bot token (long-lived)
- **Signature:** None (token-based auth)
- **Rate Limits:** ~50 messages/5 seconds per channel
- **Special Notes:** Requires MESSAGE_CONTENT intent; privileged

#### Slack
- **Inbound:** Events API (HTTP webhook) or Socket Mode (WebSocket)
- **Threading:** `thread_ts` parameter on messages
- **Auth:** OAuth 2.0 + Bot token
- **Signature:** X-Slack-Signature header validation required
- **Rate Limits:** Tiered (approx 100+ per minute for most methods)
- **Special Notes:** Socket Mode recommended for development; Events API for production

#### Teams
- **Inbound:** Azure Bot Framework webhooks
- **Threading:** Conversation ID with reply chains
- **Auth:** OAuth 2.0 via Azure AD
- **Signature:** JWT validation from Azure
- **Rate Limits:~** ~100 messages/15 seconds per bot
- **Special Notes:** Adaptive Cards for rich UI; tenant-scoped

#### Email
- **Inbound:** IMAP polling or Gmail API webhooks
- **Threading:** `Message-ID`, `In-Reply-To`, `References` headers
- **Auth:** App passwords, OAuth 2.0 (Gmail), or SMTP auth
- **Signature:** DKIM/SPF (domain-level, not per-message)
- **Rate Limits:** Provider-dependent (Gmail: ~250/day SMTP for free)
- **Special Notes:** Loop prevention critical; spoofing risk requires careful validation

#### GitHub
- **Inbound:** Repository webhook events
- **Threading:** Issue/PR number + comment ID
- **Auth:** GitHub App JWT + Installation token
- **Signature:** X-Hub-Signature-256 header validation required
- **Rate Limits:** 5,000/hour for GitHub Apps, 60/hour unauthenticated
- **Special Notes:** Event-centric (not chat); comments are issue/PR scoped

---

## Investigation Gaps

The following areas require additional investigation before implementation:

### Slack
- [ ] Enterprise Grid workspace considerations
- [ ] Workflow steps from app integration
- [ ] Block Kit builder complexity vs. simple text
- [ ] Enterprise key management (EKM) compliance

### Teams
- [ ] Multi-tenant app registration complexity
- [ ] Proactive messaging vs. reply-only constraints
- [ ] Teams-specific vs. Bot Framework generic
- [ ] Local development without Azure

### Email
- [ ] HTML vs. plain text handling strategy
- [ ] Attachment size limits across providers
- [ ] Bounce handling and undeliverable detection
- [ ] Threading algorithm for complex reply chains

### GitHub
- [ ] GitHub App vs. OAuth App tradeoffs
- [ ] Check run vs. check suite event handling
- [ ] GraphQL API vs. REST for efficiency
- [ ] GitHub Enterprise Server differences

---

## Contract Stability

This contract documentation is **documentation-only** until the code interfaces stabilize. Key areas marked as unstable:

| Area | Status | Notes |
|------|--------|-------|
| `NormalizedEvent` | ✅ Stable | Matches current normalizer.ts implementation |
| `ChannelAdapter` interface | ⚠️ Evolving | May change as first new adapter is built |
| `AdapterCapabilities` | ⚠️ Evolving | May add/remove capabilities as platforms are explored |
| `OutboundMessageTarget` | ⚠️ Evolving | May need additional routing context |
| `AdapterSendResult` | ⚠️ Evolving | May add retry/delivery status fields |

---

## See Also

- [`README.md`](./README.md) — Adapter architecture overview
- [`configuration.md`](./configuration.md) — Configuration patterns and examples
- `src/gateway/normalizer.ts` — Current NormalizedEvent implementation
- `src/gateway/index.ts` — Gateway orchestrator integration point
