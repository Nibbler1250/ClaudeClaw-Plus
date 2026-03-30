---
phase: 09-gateway-integration
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - src/commands/telegram.ts
  - src/commands/discord.ts
  - src/__tests__/gateway/adapter-wiring.test.ts
autonomous: true
requirements:
  - adapter-decoupling
  - GATEWAY-01
must_haves:
  truths:
    - "Telegram adapter routes through gateway when USE_GATEWAY_TELEGRAM=true"
    - "Discord adapter routes through gateway when USE_GATEWAY_DISCORD=true"
    - "Adapters fail with clear message when gateway disabled (not legacy fallback)"
    - "Feature flags are independent per adapter"
  artifacts:
    - path: "src/commands/telegram.ts"
      provides: "Telegram adapter with gateway routing"
      contains: "submitTelegramToGateway"
    - path: "src/commands/discord.ts"
      provides: "Discord adapter with gateway routing"
      contains: "submitDiscordToGateway"
    - path: "src/__tests__/gateway/adapter-wiring.test.ts"
      provides: "Integration tests for adapter-gateway wiring"
  key_links:
    - from: "src/commands/telegram.ts"
      to: "src/gateway/index.ts"
      via: "submitTelegramToGateway import"
      pattern: "submitTelegramToGateway"
    - from: "src/commands/discord.ts"
      to: "src/gateway/index.ts"
      via: "submitDiscordToGateway import"
      pattern: "submitDiscordToGateway"
---

<objective>
Wire Telegram and Discord adapters to route through the gateway layer, replacing direct `runUserMessage()` calls. This closes GATEWAY-01 gap (adapters bypass gateway) and implements adapter-decoupling requirement.
</objective>

<context>
@src/gateway/index.ts
@src/commands/telegram.ts
@src/commands/discord.ts

## Key Implementation Decisions (locked - do not change)

1. **Fail closed**: No legacy fallback when gateway is disabled - return error to user
2. **Per-adapter feature flags**: `USE_GATEWAY_TELEGRAM` and `USE_GATEWAY_DISCORD` env vars
3. **When flag is `true`**: route through `submitTelegramToGateway`/`submitDiscordToGateway`
4. **When flag is `false`**: fail with clear error message (not legacy path)
5. **Default**: `false` until explicitly enabled
6. **Keep adapter-specific error formatting**: current `{success, source, error}` pattern

## Gateway Helper Signatures (already built in src/gateway/index.ts)

```typescript
export async function submitTelegramToGateway(
  message: TelegramMessage
): Promise<{ success: boolean; source: "gateway" | "legacy"; error?: string; }>

export async function submitDiscordToGateway(
  message: DiscordMessage
): Promise<{ success: boolean; source: "gateway" | "legacy"; error?: string; }>
```

## Current Bypass Locations

- `src/commands/telegram.ts` line 835: `runUserMessage("telegram", prefixedPrompt)`
- `src/commands/discord.ts` line 479: `runUserMessage("discord", prefixedPrompt)`

## Message Types

```typescript
interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
  voice?: Record<string, unknown>;
  document?: Record<string, unknown>;
  // ... etc
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: { id: string; username: string; bot?: boolean };
  content: string;
  // ... etc
}
```
</context>

<tasks>

<task type="auto">
  <name>Wire Telegram adapter to gateway</name>
  <files>src/commands/telegram.ts</files>
  <action>
    Modify `src/commands/telegram.ts` to route through gateway instead of calling `runUserMessage` directly.

    1. Add import at top of file:
       ```typescript
       import { submitTelegramToGateway } from "../gateway";
       ```

    2. Find the block around line 835 that contains:
       ```typescript
       const result = await runUserMessage("telegram", prefixedPrompt);
       ```

    3. Replace that block with gateway routing:
       ```typescript
       // Check per-adapter feature flag for gateway routing
       if (process.env.USE_GATEWAY_TELEGRAM === "true") {
         const gatewayResult = await submitTelegramToGateway(message);
         if (!gatewayResult.success) {
           await sendMessage(config.token, chatId, `Gateway error: ${gatewayResult.error}`, threadId);
           return;
         }
         // Gateway processed successfully - response handled by processor
         return;
       } else {
         await sendMessage(
           config.token,
           chatId,
           "Claude is currently being upgraded. Please try again shortly.",
           threadId
         );
         return;
       }
       ```

    4. The result handling code after line 861 (`if (result.exitCode !== 0) { ... }`) should be removed since gateway routing is async and the response comes through a different path.

    IMPORTANT: The gateway path does NOT need to handle the response - the processor handles Claude execution and sends the response. Just return after successful gateway submission.

    The `message` variable in scope at line 835 is the Telegram message object passed to the handler. Use it directly with `submitTelegramToGateway(message)`.
  </action>
  <verify>
    <automated>npm test -- --filter=gateway --testPathPattern="adapter-wiring" 2>/dev/null || echo "Tests not yet created"</automated>
  </verify>
  <done>Telegram adapter routes through gateway when USE_GATEWAY_TELEGRAM=true, returns clear error when false</done>
</task>

<task type="auto">
  <name>Wire Discord adapter to gateway</name>
  <files>src/commands/discord.ts</files>
  <action>
    Modify `src/commands/discord.ts` to route through gateway instead of calling `runUserMessage` directly.

    1. Add import at top of file:
       ```typescript
       import { submitDiscordToGateway } from "../gateway";
       ```

    2. Find the block around line 479 that contains:
       ```typescript
       const result = await runUserMessage("discord", prefixedPrompt);
       ```

    3. Replace that block with gateway routing:
       ```typescript
       // Check per-adapter feature flag for gateway routing
       if (process.env.USE_GATEWAY_DISCORD === "true") {
         const gatewayResult = await submitDiscordToGateway(message);
         if (!gatewayResult.success) {
           await sendMessage(config.token, channelId, `Gateway error: ${gatewayResult.error}`);
           return;
         }
         // Gateway processed successfully - response handled by processor
         return;
       } else {
         await sendMessage(
           config.token,
           channelId,
           "Claude is currently being upgraded. Please try again shortly."
         );
         return;
       }
       ```

    4. The result handling code after line 491 (`if (result.exitCode !== 0) { ... }`) should be removed since gateway routing is async and the response comes through a different path.

    IMPORTANT: The gateway path does NOT need to handle the response - the processor handles Claude execution and sends the response. Just return after successful gateway submission.

    The `message` variable in scope at line 479 is the Discord message object passed to the handler. Use it directly with `submitDiscordToGateway(message)`.
  </action>
  <verify>
    <automated>npm test -- --filter=gateway --testPathPattern="adapter-wiring" 2>/dev/null || echo "Tests not yet created"</automated>
  </verify>
  <done>Discord adapter routes through gateway when USE_GATEWAY_DISCORD=true, returns clear error when false</done>
</task>

<task type="auto">
  <name>Add integration tests for adapter-gateway wiring</name>
  <files>src/__tests__/gateway/adapter-wiring.test.ts</files>
  <action>
    Create integration test file `src/__tests__/gateway/adapter-wiring.test.ts` to verify the adapter-gateway wiring.

    The test file should cover:

    1. **Telegram gateway routing**:
       - When `USE_GATEWAY_TELEGRAM=true`: `submitTelegramToGateway` is called
       - When `USE_GATEWAY_TELEGRAM=false`: clear error message returned (not legacy fallback)
       - When gateway returns error: error is surfaced to user

    2. **Discord gateway routing**:
       - When `USE_GATEWAY_DISCORD=true`: `submitDiscordToGateway` is called
       - When `USE_GATEWAY_DISCORD=false`: clear error message returned (not legacy fallback)
       - When gateway returns error: error is surfaced to user

    3. **Feature flag isolation**:
       - Telegram flag doesn't affect Discord routing
       - Discord flag doesn't affect Telegram routing

    Use mocking to simulate gateway responses. The tests should verify the decision logic, not re-test the gateway itself (which has its own tests).

    ```typescript
    import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

    describe('Adapter Gateway Wiring', () => {
      // ... tests
    });
    ```
  </action>
  <verify>
    <automated>npm test -- --filter=adapter-wiring</automated>
  </verify>
  <done>Integration tests verify gateway routing works correctly for both adapters with proper feature flag behavior</done>
</task>

</tasks>

<verification>
1. `npm test -- --filter=gateway` passes (all gateway tests including new adapter-wiring tests)
2. TypeScript compilation succeeds with no errors
3. Feature flags are independent - setting one doesn't affect the other
</verification>

<success_criteria>
- Telegram adapter routes through gateway when `USE_GATEWAY_TELEGRAM=true`
- Discord adapter routes through gateway when `USE_GATEWAY_DISCORD=true`
- Both adapters return clear error when respective flag is `false`
- No legacy `runUserMessage` fallback path is invoked
- Integration tests confirm correct routing behavior
</success_criteria>

<output>
After completion, create `.planning/phases/09-gateway-integration/09-01-SUMMARY.md`
</output>
