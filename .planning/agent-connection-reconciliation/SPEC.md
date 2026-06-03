---
phase: agent-connection-reconciliation
type: spec
status: draft
authors: [Nibbler1250]
depends_on:
  - "#207 (per-message receipt chain — data-plane observability)"
  - "#213 (agent-scoped session rotation — the churn trigger)"
  - "#165 (multiplexer issuer ordered before agent spawn)"
files_modified_planned:
  - src/bus/core.ts            # sendPrompt readiness gate + observable failure
  - src/bus/core-ipc.ts        # surface hello/close as readiness events
  - src/bus/session-manager.ts # readiness registry + reconciliation watchdog
  - src/bus/receipt.ts         # new terminal state: no_connection
  - src/config.ts              # connectionReadyTimeoutMs / connectionStaleMs / maxPendingPerAgent
requirements: [CONN-01, CONN-02, CONN-03, CONN-04, CONN-05, CONN-06, CONN-07]
---

# Agent Connection Reconciliation — SPEC

## Executive summary

A bus agent's **process liveness** and its **MCP/IPC connection** are tracked
independently, with no invariant binding them. When the process is alive but no
connection is registered (`connectionsByAgent` has no entry for the agent —
during a respawn window, or after the MCP client drops), `BusCore.sendPrompt`
calls `ipcServer.send(agent_id, ...)`, which returns `false`; `core.ts` logs
`No MCP connection for agent_id=<id>` and **drops the prompt** — no queue, no
retry, no respawn. The agent remains **alive-but-deaf** indefinitely; nothing
reconciles the two states. Operator-visible symptom: the agent silently stops
responding until a manual restart happens to land a process whose MCP
connection establishes cleanly.

**Trigger amplifier:** the session-id collision churn (#213) repeatedly tears
down and slowly re-establishes the connection, widening the deaf window.

**Why #207/#211 don't fix it:** they make the wedge *legible* (a receipt closes
`timeout` with `stdin_written=false` ⇒ the prompt never reached the agent) but
do not *act* on it. This spec is the **control-plane** that closes the loop
#207 opened on the **data-plane**.

### Live evidence
- `error: No MCP connection for agent_id=default` (`core.ts:296`).
- #211 receipts closing `timeout`, `stdin_written` absent, while the agent
  `claude` process is alive and idle (~3% CPU).

## Invariants (north star)

- **INV-1** — An agent is `ready` iff *(process spawned)* ∧ *(`hello`
  handshake received)* ∧ *(connection open)*. Source of truth: the IPC server's
  `connectionsByAgent` + the SessionManager process registry.
- **INV-2** — `sendPrompt` MUST NOT silently drop. A prompt to a not-ready
  agent resolves to exactly one of: **delivered** (after a bounded readiness
  wait) or an **observable distinct terminal state** (`no_connection`).
- **INV-3** — An agent that is process-alive but not-ready for longer than
  `connectionStaleMs` MUST be reconciled (agent respawn) with a captured
  post-mortem; reconciliation is **bounded** (no respawn loop).

## Requirements

- **CONN-01** — Readiness registry: SessionManager derives per-agent readiness
  from IPC `onHello`/`onClose` events. `ready(agentId): boolean` + `lastHelloAt`.
- **CONN-02** — No silent drop: `sendPrompt` to a not-ready agent awaits
  readiness up to `connectionReadyTimeoutMs` (bounded), then delivers; on
  timeout it fails **observably** (CONN-03), never silently.
- **CONN-03** — Distinct terminal state: a no-connection failure closes the
  receipt as **`no_connection`** (NEW), distinct from `timeout` /
  `wedged_prompt` / `stale_session`, so it is countable. Diagnostic
  distinction it enables: `no_connection` (control-plane — never reached the
  agent) vs `wedged_prompt`/`timeout` with `stdin_written` (data-plane —
  reached the agent, no turn).
- **CONN-04** — Self-heal in-process: alive-but-not-ready > `connectionStaleMs`
  ⇒ respawn the **agent** (not the daemon), emitting a post-mortem via the
  existing `claudeclaw-restart-tracker`. Bounded attempts + backoff; after N,
  surface a hard `manual-intervention` error (mirrors the existing rotation
  retry-cap semantics).
- **CONN-05** — Bounded buffering: the readiness wait is a per-agent queue
  bounded by `maxPendingPerAgent` + per-entry TTL. Overflow/expiry ⇒
  `no_connection` (logged), never an unbounded silent buffer.
- **CONN-06** — Audit: every reconciliation action (respawn, overflow-drop,
  late-delivery-after-reconnect) emits an audit/log line. No silent caps.
- **CONN-07** — Observability: expose per-agent `ready` + `lastHelloAt` on a
  readiness surface, kept **distinct** from the unauth `/health` liveness probe
  (readiness ≠ liveness).

## Failure-state taxonomy (extends the #207 receipt vocab)

| state | meaning | plane |
|---|---|---|
| `turn_observed` | reply delivered | data |
| `wedged_prompt` / `timeout` (`stdin_written=true`) | reached the agent, no turn | data |
| **`no_connection`** (NEW, `stdin_written=false`) | agent not ready, prompt never written | **control** |
| `stale_session` | PTY rejected the write | data |

## Design

1. **Readiness registry** (SessionManager): subscribe to `onHello`/`onClose`
   from `core-ipc`; maintain `{ ready, lastHelloAt, pendingWaiters }` per agent.
2. **`sendPrompt` gate** (core.ts): if `!ready(agent)` → enqueue a bounded
   waiter and `await` a readiness promise resolved on the next `hello`, capped
   at `connectionReadyTimeoutMs`. On resolve → `ipcServer.send` (deliver). On
   timeout/overflow → close receipt `no_connection` + return observable error.
3. **Reconciliation watchdog**: event-driven (on first not-ready send) +
   periodic sweep — process alive ∧ not-ready > `connectionStaleMs` ⇒ bounded
   agent respawn with restart-tracker post-mortem.
4. **Config** (conservative defaults): `connectionReadyTimeoutMs` (e.g. 30000),
   `connectionStaleMs` (e.g. 60000), `maxPendingPerAgent` (e.g. 8).

## Relationship to the in-flight stack (de-duplication)

Deconflicted against the open #207 arc (verified: an issue/PR search for
`No MCP connection` / readiness / reconnect / disconnect returns nothing):

- **#209 / #211 / #221 (receipts)** — data-plane *observability* this builds on.
  `no_connection` is a NEW terminal state, **additive** to #209's vocab
  (`message_polled` / `route_resolved` / `stdin_written` / `turn_observed` /
  `wedged_prompt` / `stale_session` / `timeout`), not a redefinition.
- **#217 / #215 (synthesize reply)** — fixes the **OUTPUT** end of the pipe: the
  agent completed a turn but never called `reply`, so the text is lost. This
  spec fixes the **INPUT** end: the prompt never reached the agent (no
  connection), so no turn happens at all. Opposite ends; complementary, not
  overlapping.
- **#218 / #213 (session rotation)** — the **trigger** (collision churn that
  tears down the connection). Non-goal here; logged, not fixed.
- **#212 (turn_event_offset)** — orthogonal data-plane refinement.

No open PR/issue addresses the no-connection / readiness **control loop** — this
is the uncovered gap.

## Non-goals

- Fixing the session-id collision churn root (#213). This spec makes the
  **symptom** (deaf agent) self-healing + observable regardless of churn cause;
  the churn is logged so it stays visible (CONN-06), not masked.
- Multi-MCP-connection-per-agent.
- Persisting the pending queue across daemon restart (in-memory, bounded).

## Acceptance criteria

- **AC-1** (CONN-02): a prompt sent before the agent connects, where `hello`
  arrives within `connectionReadyTimeoutMs`, is **delivered** (no drop).
- **AC-2** (CONN-03): agent never connects within timeout ⇒ receipt closes
  `no_connection` (not `timeout`), countable.
- **AC-3** (CONN-04): alive-but-not-ready > `connectionStaleMs` ⇒ exactly one
  respawn + one post-mortem; bounded (asserts no loop).
- **AC-4** (CONN-05): pending overflow / TTL expiry ⇒ `no_connection`, logged.
- **AC-5**: no regression in existing `src/bus` + adapter suites.

## Risks & mitigations

- **R1 — Stale late-delivery** (the anti-silent-buffer concern): bounded TTL;
  past TTL ⇒ `no_connection`, never a stale out-of-context delivery.
- **R2 — Respawn loop**: bounded attempts + backoff; after N, hard error
  surfaced (reuse rotation's `manual-intervention` pattern).
- **R3 — Readiness false-negative on hello race**: readiness derived solely
  from the authoritative `connectionsByAgent`; `onHello` is the single writer.
- **R4 — Masking the churn root**: every self-heal action is audited (CONN-06)
  so #213's churn remains visible rather than hidden by the heal.

## Rollback

Config-gated: `connectionReadyTimeoutMs = 0` ⇒ legacy behaviour (immediate
fail), with the only delta vs today being that the failure is observable
(`no_connection`) instead of a silent drop. Set to disable wait/queue/respawn.

## Refs
#207, #211, #213, #165.
