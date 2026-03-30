# Phase 9: Gateway Integration - Context

**Gathered:** 2026-03-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Wire telegram and discord adapters to route through the gateway, replacing direct `runUserMessage()` calls. The gateway (built in Phase 2) provides session isolation, policy enforcement, and event persistence — but adapters currently bypass it (GATEWAY-01 gap).

This is a wiring/integration phase — no new modules, just connections.

</domain>

<decisions>
## Implementation Decisions

### Fallback behavior
- **Fail closed** — No legacy fallback when gateway is disabled or fails
- `submitTelegramToGateway`/`submitDiscordToGateway` return error to user rather than falling back to `runUserMessage`
- Rationale: Gateway is the core architectural layer; silent fallback defeats governance and session isolation
- Legacy `runUserMessage` path should not be invoked as fallback during migration

### Migration strategy
- **Per-adapter feature flags** — `USE_GATEWAY_TELEGRAM` and `USE_GATEWAY_DISCORD` env vars
- Enables gradual cutover: test Telegram first, then Discord independently
- When flag is `true`: route through `submitTelegramToGateway`/`submitDiscordToGateway`
- When flag is `false`: fail with clear error message (not legacy path)
- Default: `false` until explicitly enabled

### Error responses
- **Keep adapter-specific error formatting** — current `{success, source, error}` pattern is sufficient
- `source` field indicates "gateway" vs "legacy" provenance
- Telegram/Discord surface errors in their own format (HTML vs Discord embeds)
- Don't normalize error formats across adapters during this phase

### Claude's Discretion
- Exact error message wording per adapter
- How to handle partial failures (e.g., gateway success but processor fails)
- Test scenarios and coverage targets

</decisions>

<specifics>
## Specific Ideas

- **Gateway helper functions already exist:** `submitTelegramToGateway()` and `submitDiscordToGateway()` in `src/gateway/index.ts`
- **These helpers normalize and call `processEventWithFallback`** — but the helpers' legacy handler returns hardcoded error (no actual legacy path)
- **Target pattern:** Adapter calls `submitXToGateway()` → gateway routes through `processInboundEvent()` → event log → processor
- **The `runUserMessage` calls to replace:**
  - `telegram.ts` line 835: `runUserMessage("telegram", prefixedPrompt)`
  - `discord.ts` line 479: `runUserMessage("discord", prefixedPrompt)`

</specifics>

<code_context>
## Existing Code Insights

### Integration Points
- `src/commands/telegram.ts` — telegram adapter (needs gateway routing)
- `src/commands/discord.ts` — discord adapter (needs gateway routing)
- `src/gateway/index.ts` — gateway orchestrator with `submitTelegramToGateway`/`submitDiscordToGateway`
- `src/gateway/normalizer.ts` — `normalizeTelegramMessage`, `normalizeDiscordMessage` already exist
- `src/event-processor.ts` — processor that receives persisted events

### Reusable Assets
- `submitTelegramToGateway()` / `submitDiscordToGateway()` — already built, need wiring
- `normalizeTelegramMessage()` / `normalizeDiscordMessage()` — already built
- `processEventWithFallback()` — gateway fallback orchestrator (not used as actual fallback per decision)
- `isGatewayEnabled()` pattern — extend to per-adapter flags

### Established Patterns
- Feature flag pattern via env vars (already used for `USE_GATEWAY`)
- Adapter helper functions in gateway/index.ts (already exist, unwired)
- Per-channel routing (`telegram:channelId` format already established)

</code_context>

<deferred>
## Deferred Ideas

- Global `USE_GATEWAY` flag removal — after both adapters migrated
- Legacy `runUserMessage` code removal — after migration verified
- Slack/Teams/Email adapters — separate phases (7-01 scaffolds exist)

</deferred>

---

*Phase: 09-gateway-integration*
*Context gathered: 2026-03-30*
