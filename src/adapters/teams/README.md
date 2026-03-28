# Microsoft Teams Adapter

Implementation-ready scaffold for a future Microsoft Teams adapter.

**Status:** Documentation/scaffolding only — no working implementation  
**Version:** 1.0  
**Last Updated:** 2026-03-28

---

## ⚠️ Important Notice

This directory contains **documentation and scaffolding only**. There is no working Teams adapter implementation. This scaffold exists to guide future implementation work.

---

## Overview

Microsoft Teams is a workplace collaboration platform built on the Azure Bot Framework. Teams integration requires Azure registration and uses Bot Framework protocols for messaging.

### Key Characteristics

- **Platform:** Microsoft Teams (teams.microsoft.com)
- **Underlying Framework:** Azure Bot Framework
- **Inbound Mode:** Webhook (Azure Bot Framework)
- **Threading:** Conversation-based with reply chains
- **Auth:** OAuth 2.0 via Azure Active Directory
- **Rate Limits:** ~100 messages per 15 seconds per bot

---

## Environment Variables

```bash
# Required: Microsoft App ID (from Azure Bot registration)
TEAMS_APP_ID=your-app-id

# Required: Microsoft App Password (from Azure Bot registration)
TEAMS_APP_PASSWORD=your-app-password

# Required: Public webhook URL for Bot Framework
TEAMS_WEBHOOK_URL=https://your-domain.com/webhooks/teams

# Optional: Tenant ID for single-tenant deployment
# TEAMS_TENANT_ID=your-tenant-id

# Optional: Channel for notifications
# TEAMS_DEFAULT_CHANNEL=general

# Optional: Enable debug logging
# TEAMS_DEBUG=true

# Optional: Azure Bot Framework endpoint (default: standard)
# TEAMS_BOT_ENDPOINT=https://smba.trafficmanager.net/teams/api/messages
```

---

## Azure/Bot Framework Registration Steps

### 1. Create Azure Bot Resource

1. Go to [Azure Portal](https://portal.azure.com)
2. Create new resource → **Azure Bot**
3. Fill in details:
   - Bot handle: unique name (e.g., "claudeclaw-bot")
   - Subscription: your Azure subscription
   - Resource group: create or select existing
   - Pricing tier: Free (F0) for development
4. Click **Create**

### 2. Configure Microsoft App Registration

1. In Azure Bot resource, go to **Configuration**
2. Note the **Microsoft App ID** (auto-created)
3. Click **Manage** next to Microsoft App ID
4. Go to **Certificates & secrets**
5. Create **New client secret**
6. Copy the secret value (shown only once)
7. Store as `TEAMS_APP_PASSWORD`

### 3. Configure Messaging Endpoint

1. In Azure Bot resource, go to **Configuration**
2. Set **Messaging endpoint** to your public webhook URL:
   ```
   https://your-domain.com/webhooks/teams/api/messages
   ```
3. Ensure HTTPS with valid certificate
4. Save changes

### 4. Enable Teams Channel

1. In Azure Bot resource, go to **Channels**
2. Click **Microsoft Teams**
3. Agree to terms of service
4. Click **Save**
5. Teams channel status should show as "Running"

### 5. Install Bot to Teams

Option A: Upload custom app (development)
1. In Teams, go to **Apps** → **Manage your apps** → **Upload an app**
2. Upload app manifest (zip with manifest.json)
3. Add to team or chat

Option B: Publish to org (production)
1. Submit to Teams Admin Center
2. Admin approves and deploys
3. Users find in Teams app catalog

---

## Auth Model

Teams uses Azure AD OAuth 2.0:

### App ID + Password (Client Secret)

- **Microsoft App ID:** UUID identifying the app registration
- **App Password:** Client secret for authentication
- **Authentication:** Basic auth (App ID as username, password as... password)
- **Token Endpoint:** Azure AD token service

### JWT Validation (Inbound)

Azure Bot Framework signs all requests with JWT:

```
Authorization: Bearer eyJ0eXAiOiJKV1Qi...
```

Validation steps:
1. Extract JWT from Authorization header
2. Fetch OpenID configuration from Azure AD:
   ```
   https://login.botframework.com/v1/.well-known/openidconfiguration
   ```
3. Get signing keys from `jwks_uri`
4. Validate JWT signature
5. Validate issuer (`https://api.botframework.com`)
6. Validate audience (your Microsoft App ID)
7. Check token expiration

```typescript
// Pseudocode for JWT validation
async function validateTeamsJwt(
  token: string,
  appId: string
): Promise<boolean> {
  const openIdConfig = await fetch(
    'https://login.botframework.com/v1/.well-known/openidconfiguration'
  ).then(r => r.json());
  
  const jwks = await fetch(openIdConfig.jwks_uri).then(r => r.json());
  
  // Verify signature with JWKS
  const decoded = await jwtVerify(token, createLocalJWKSet(jwks), {
    issuer: 'https://api.botframework.com',
    audience: appId,
  });
  
  return decoded !== null;
}
```

---

## Conversation and Threading Semantics

Teams threading is conversation-based:

### Key Concepts

- **Conversation:** A chat context (channel, group chat, or 1:1)
- **Activity:** A message or event within a conversation
- **ReplyToId:** Reference to parent activity (for threading)

### Conversation Reference

```json
{
  "activityId": "1234567890",
  "user": { "id": "29:...", "name": "User Name" },
  "bot": { "id": "28:...", "name": "ClaudeClaw" },
  "conversation": {
    "id": "19:...",
    "conversationType": "channel",
    "tenantId": "..."
  },
  "channelId": "msteams",
  "serviceUrl": "https://smba.trafficmanager.net/teams/"
}
```

### Conversation Types

| Type | conversationType | Context |
|------|------------------|---------|
| Channel | `channel` | Post in team channel |
| Group chat | `groupChat` | Multi-person chat |
| Personal | `personal` | 1:1 bot conversation |

### Inbound Thread Detection

```json
{
  "type": "message",
  "id": "1234567890",
  "replyToId": "1234567800",
  "conversation": { "id": "19:..." },
  "text": "Reply text"
}
```

- `replyToId` present: message is a reply in a thread
- No `replyToId`: top-level message

### Outbound Reply

To reply to a specific message:

```typescript
// Reply to conversation (respects thread context)
await adapter.continueConversation(conversationReference, async (context) => {
  await context.sendActivity({
    type: 'message',
    text: 'Reply text',
    replyToId: parentActivityId  // For threading
  });
});
```

To start a new thread in a channel:

```typescript
// Create new conversation (new thread)
const response = await adapter.createConversation(conversationReference, async (context) => {
  await context.sendActivity('New thread starter');
  return context.activity.id;
});
```

---

## Adaptive Card Considerations

Teams supports rich UI via Adaptive Cards:

### Simple Text

```typescript
await context.sendActivity('Plain text message');
```

### Markdown

```typescript
await context.sendActivity({
  text: '**Bold** and _italic_ text',
  textFormat: 'markdown'
});
```

### Adaptive Card

```json
{
  "type": "AdaptiveCard",
  "version": "1.4",
  "body": [
    {
      "type": "TextBlock",
      "text": "Hello from ClaudeClaw",
      "weight": "bolder",
      "size": "medium"
    },
    {
      "type": "TextBlock",
      "text": "This is an Adaptive Card",
      "wrap": true
    }
  ],
  "actions": [
    {
      "type": "Action.Submit",
      "title": "Click me",
      "data": { "action": "button_clicked" }
    }
  ]
}
```

### Platform-Specific Considerations

- Teams supports up to Adaptive Cards 1.5 (check latest)
- Some card features may not render in all Teams clients (desktop vs mobile)
- Hero cards and thumbnail cards also supported for simpler layouts
- Action.Submit requires handling `invoke` activities

---

## Local Testing Approach

### Development Tunnel

Azure Bot Framework requires HTTPS webhook. Use a tunnel:

```bash
# ngrok
ngrok http 3978

# Dev Tunnels (Visual Studio)
devtunnel host -p 3978
```

Update Azure Bot messaging endpoint to tunnel URL.

### Bot Framework Emulator

1. Download [Bot Framework Emulator](https://github.com/microsoft/BotFramework-Emulator)
2. Run locally without Azure
3. Connect to `http://localhost:3978/api/messages`
4. Test conversations without Teams client

**Limitations:**
- Doesn't test Teams-specific features (Adaptive Cards may differ)
- No channel/thread context
- Good for basic message flow testing

### Teams Testing

1. Sideload app in Teams (developer preview if needed)
2. @mention bot in channel or DM
3. Test threading by replying to bot messages
4. Verify Adaptive Cards render correctly

---

## Deployment Considerations

### Single Tenant vs Multi-Tenant

| Mode | Use Case | Configuration |
|------|----------|---------------|
| Multi-tenant | SaaS offering | Default; any tenant can add bot |
| Single-tenant | Enterprise only | Set `TEAMS_TENANT_ID`; only specified tenant |

### Service URL Handling

Azure Bot Framework uses regional service URLs:
- `https://smba.trafficmanager.net/teams/` (Global)
- `https://smba.trafficmanager.net/apac/` (Asia-Pacific)
- `https://smba.trafficmanager.net/emea/` (Europe)

Always use `serviceUrl` from incoming activity for outbound replies.

---

## Rate Limit and Tenant Considerations

### Rate Limits

- ~100 activities per 15 seconds per bot per channel
- Burst allowed but sustained rate matters
- HTTP 429 with `Retry-After` header on limit

### Tenant Isolation

- Each Teams tenant is isolated
- Bot must be installed per tenant
- Cross-tenant messages require multi-tenant registration

### Performance

- Webhook responses must be fast (< 15 seconds)
- Async processing: return 202 Accepted, continue processing
- Queue long-running operations

---

## Normalization Mapping

Mapping Teams activities to `NormalizedEvent`:

| NormalizedEvent | Teams Source |
|-----------------|--------------|
| `channel` | `"teams"` |
| `sourceEventId` | `activity.id` |
| `channelId` | `activity.conversation.id` with prefix |
| `threadId` | `activity.conversation.id` (thread = conversation in Teams) |
| `userId` | `activity.from.id` |
| `text` | `activity.text` |
| `metadata.replyTo` | `activity.replyToId` |
| `metadata.conversationType` | `activity.conversation.conversationType` |
| `metadata.tenantId` | `activity.conversation.tenantId` |

### Channel ID Format

```typescript
// Format: teams:{tenantId}:{conversationId}
const channelId = `teams:${activity.conversation.tenantId}:${activity.conversation.id}`;
```

---

## Open Investigation Questions

- [ ] **Multi-tenant complexity:** How to handle app registration across tenants?
- [ ] **Proactive messaging:** Can bot message users without prior interaction?
- [ ] **Teams vs Bot Framework:** Which APIs to use for Teams-specific features?
- [ ] **Local development:** Can we test without Azure subscription?
- [ ] **Channel vs Chat:** How to handle different conversation types uniformly?
- [ ] **File uploads:** What's the best approach for attachment handling?
- [ ] **Meeting context:** Should we support meeting chat interactions?

---

## Implementation Readiness Checklist

Before implementing this adapter:

- [ ] Azure subscription available
- [ ] Azure Bot resource created
- [ ] Microsoft App ID obtained
- [ ] App password/client secret created
- [ ] Teams channel enabled on bot
- [ ] Public HTTPS webhook endpoint available
- [ ] Teams tenant for testing identified
- [ ] App manifest created for sideloading
- [ ] JWT validation library selected
- [ ] Single vs multi-tenant strategy decided

---

## Platform Differences from Slack

| Aspect | Slack | Teams |
|--------|-------|-------|
| **Framework** | Slack API | Azure Bot Framework |
| **Auth** | Bot token | Azure AD OAuth |
| **Inbound** | Events API or Socket | Webhook only |
| **Threading** | `thread_ts` | Conversation + `replyToId` |
| **Rich UI** | Block Kit | Adaptive Cards |
| **Local dev** | Socket Mode (no public URL) | Requires tunnel or emulator |
| **Deployment** | App directory | Azure + Teams admin |
| **Rate limits** | Tiered by method | ~100/15s per bot |

Teams requires more infrastructure (Azure) but provides deeper Microsoft 365 integration.

---

## See Also

- [Azure Bot Service Documentation](https://docs.microsoft.com/azure/bot-service/)
- [Teams Bot Development](https://docs.microsoft.com/microsoftteams/platform/bots/what-are-bots)
- [Adaptive Cards Designer](https://adaptivecards.io/designer/)
- [Bot Framework SDK](https://github.com/microsoft/botbuilder-js)
- [`../README.md`](../README.md) — Adapter architecture overview
- [`../contracts.md`](../contracts.md) — Capability matrix
- [`../configuration.md`](../configuration.md) — Configuration patterns
