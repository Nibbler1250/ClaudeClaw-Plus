/**
 * When an operation id cannot be trusted, the envelope has to say so.
 *
 * `promise_id` is per-agent, not per-operation, so a prompt arriving while the
 * previous turn has not reached its terminator makes every event after it
 * carry an id that may belong to the other turn. A client cannot detect that
 * from outside: correlation looks exact and is wrong, which is the failure
 * class §3.2 exists to keep out of this seam, arriving through a different
 * door.
 *
 * The existing `originAmbiguous` set is NOT the right signal, and these tests
 * pin why. It is armed from and cleared with `lastPromptOrigin`, which the
 * final reply releases — so it is blind to the window between a turn's final
 * reply and its lagged `response.turn_end`, and it is already gone by the time
 * the events that most need correlating are published.
 *
 * Run with: `bun test src/bus/__tests__/correlation-ambiguity.test.ts`
 */

import { describe, it, expect } from "bun:test";
import { randomUUID } from "crypto";
import { createBusCore, type BusCore } from "../core";
import type { BusEvent } from "../types";

const mockAppend = (async () => ({ id: randomUUID() })) as unknown as never;

function makeBus(): { bus: BusCore; events: BusEvent[] } {
  const events: BusEvent[] = [];
  const bus = createBusCore({ eventLogAppend: mockAppend, onError: () => {} });
  bus.subscribe({}, (e) => events.push(e));
  return { bus, events };
}

function prompt(bus: BusCore, agent_id: string, text: string) {
  return bus.sendPrompt({ agent_id, origin: "webui", origin_id: "http", user_id: "u", text });
}

function tailerEvent(agent_id: string, topic: BusEvent["topic"], payload: unknown = {}): BusEvent {
  return { ts: Date.now(), agent_id, session_id: "sess-1", topic, payload };
}

const flagged = (events: BusEvent[]) =>
  events.filter((e) => (e as { correlation_ambiguous?: true }).correlation_ambiguous === true);

describe("correlation ambiguity on the envelope", () => {
  it("a clean single turn is not flagged", async () => {
    const { bus, events } = makeBus();
    await prompt(bus, "a", "one");
    bus.ingestSessionEvent(tailerEvent("a", "response.text", { text: "hi" }));
    expect(flagged(events)).toEqual([]);
  });

  it("a second prompt while the first has not terminated flags what follows", async () => {
    const { bus, events } = makeBus();
    await prompt(bus, "a", "one");
    // No turn_end for the first: its slot is still occupied.
    await prompt(bus, "a", "two");
    bus.ingestSessionEvent(tailerEvent("a", "response.text", { text: "hi" }));
    expect(flagged(events).length).toBeGreaterThan(0);
  });

  it("flags the lagged-turn_end window that originAmbiguous cannot see", async () => {
    // The sequential race (#217 finding 3, deferred #239): the first turn
    // produces its final reply, the second is submitted, and only then does the
    // first turn's `response.turn_end` arrive — stamped with the second
    // operation's id. `lastPromptOrigin` is cleared by the final reply, so a
    // taint armed from it is already gone here. Keyed on the operation slot,
    // which outlives the final reply, this window is covered.
    const { bus, events } = makeBus();
    await prompt(bus, "a", "one");
    bus.ingestReply({ agent_id: "a", intent: "final", text: "done" } as never);
    await prompt(bus, "a", "two");
    events.length = 0;
    bus.ingestSessionEvent(tailerEvent("a", "response.turn_end"));
    expect(flagged(events).length).toBeGreaterThan(0);
  });

  it("the turn_end that ends the turn clears the taint for the next one", async () => {
    const { bus, events } = makeBus();
    await prompt(bus, "a", "one");
    await prompt(bus, "a", "two");
    bus.ingestSessionEvent(tailerEvent("a", "response.turn_end"));
    await prompt(bus, "a", "three");
    events.length = 0;
    bus.ingestSessionEvent(tailerEvent("a", "response.text", { text: "clean" }));
    expect(flagged(events)).toEqual([]);
  });

  it("agents stay apart — one agent's overlap does not taint another", async () => {
    const { bus, events } = makeBus();
    await prompt(bus, "a", "one");
    await prompt(bus, "a", "two"); // a is now ambiguous
    await prompt(bus, "b", "one"); // b is clean
    events.length = 0;
    bus.ingestSessionEvent(tailerEvent("b", "response.text", { text: "hi" }));
    expect(flagged(events)).toEqual([]);
  });

  it("the flag never rides alone — no operation id, no flag", async () => {
    // An event outside any turn has nothing for the flag to qualify. Emitting
    // it there would tell a client its correlation is uncertain when it has no
    // correlation at all.
    const { bus, events } = makeBus();
    bus.ingestSessionEvent(tailerEvent("never-prompted", "response.text", { text: "orphan" }));
    const orphans = events.filter((e) => e.agent_id === "never-prompted");
    expect(orphans.length).toBeGreaterThan(0);
    for (const e of orphans) {
      expect((e as { correlation_ambiguous?: true }).correlation_ambiguous).toBeUndefined();
      expect(e.promise_id).toBeUndefined();
    }
  });

  it("the caller's event object is not mutated", async () => {
    const { bus } = makeBus();
    await prompt(bus, "a", "one");
    await prompt(bus, "a", "two");
    const mine = tailerEvent("a", "response.text", { text: "hi" });
    bus.ingestSessionEvent(mine);
    expect((mine as { correlation_ambiguous?: true }).correlation_ambiguous).toBeUndefined();
    expect(mine.promise_id).toBeUndefined();
  });
});
