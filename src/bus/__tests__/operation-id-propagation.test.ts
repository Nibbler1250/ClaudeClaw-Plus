/**
 * `promise_id` must reach the events of the turn it started, not just the
 * caller of `sendPrompt`.
 *
 * Before this, the identifier travelled exactly one hop: it was minted in
 * `sendPrompt`, returned to the submitter, written into the payload of the
 * `prompt` event — and then nothing carried it further. A client holding the
 * value from `POST /prompt` had no way to recognise the events that answered
 * it, because the other bridge is unusable too: `session_id` is `""` at the
 * prompt boundary. The only remaining option was inferring correlation from
 * agent id plus arrival order, which is exactly the inference a control client
 * must not be asked to do.
 *
 * Run with: `bun test src/bus/__tests__/operation-id-propagation.test.ts`
 */

import { describe, it, expect } from "bun:test";
import { randomUUID } from "crypto";
import { createBusCore, type BusCore } from "../core";
import type { BusEvent } from "../types";

const mockAppend = (async () => ({ id: randomUUID() })) as unknown as never;

function makeBus(): { bus: BusCore; events: BusEvent[] } {
  const events: BusEvent[] = [];
  // Swallow the error the `error` IPC path reports by design — the test
  // asserts the slot is released, not that the bus stays quiet.
  const bus = createBusCore({ eventLogAppend: mockAppend, onError: () => {} });
  bus.subscribe({}, (e) => events.push(e));
  return { bus, events };
}

function prompt(bus: BusCore, agent_id: string, text: string) {
  return bus.sendPrompt({
    agent_id,
    origin: "webui",
    origin_id: "http",
    user_id: "user-1",
    text,
  });
}

/** A tailer-shaped event: built elsewhere, handed to the bus, no id of its own. */
function tailerEvent(agent_id: string, topic: BusEvent["topic"], payload: unknown): BusEvent {
  return { ts: Date.now(), agent_id, session_id: "sess-1", topic, payload };
}

describe("operation id propagation", () => {
  it("stamps the id returned by sendPrompt onto the prompt event itself", async () => {
    const { bus, events } = makeBus();

    const { promise_id } = await prompt(bus, "alpha", "hello");

    const promptEvents = events.filter((e) => e.topic === "prompt");
    expect(promptEvents).toHaveLength(1);
    expect(promptEvents[0].promise_id).toBe(promise_id);
  });

  it("carries it onto downstream events the tailer hands over", async () => {
    const { bus, events } = makeBus();
    const { promise_id } = await prompt(bus, "alpha", "hello");

    bus.ingestSessionEvent(tailerEvent("alpha", "response.text", { text: "working" }));
    bus.ingestSessionEvent(tailerEvent("alpha", "response.tool_use", { id: "t1" }));
    bus.ingestSessionEvent(tailerEvent("alpha", "usage", { input_tokens: 1 }));

    const downstream = events.filter((e) => e.topic !== "prompt");
    expect(downstream.length).toBeGreaterThanOrEqual(3);
    for (const e of downstream) {
      expect(e.promise_id).toBe(promise_id);
    }
  });

  it("carries it onto response.turn_end — the event a client most needs correlated", async () => {
    const { bus, events } = makeBus();
    const { promise_id } = await prompt(bus, "alpha", "hello");

    bus.ingestSessionEvent(tailerEvent("alpha", "response.turn_end", { text: "" }));

    const turnEnd = events.filter((e) => e.topic === "response.turn_end");
    expect(turnEnd).toHaveLength(1);
    expect(turnEnd[0].promise_id).toBe(promise_id);
  });

  it("stops stamping once the turn has ended", async () => {
    const { bus, events } = makeBus();
    await prompt(bus, "alpha", "hello");

    bus.ingestSessionEvent(tailerEvent("alpha", "response.turn_end", { text: "" }));
    bus.ingestSessionEvent(tailerEvent("alpha", "response.text", { text: "late echo" }));

    const late = events.filter((e) => e.topic === "response.text");
    expect(late).toHaveLength(1);
    expect(late[0].promise_id).toBeUndefined();
  });

  it("keeps agents apart — one agent's turn never stamps another's events", async () => {
    const { bus, events } = makeBus();
    const a = await prompt(bus, "alpha", "for alpha");
    const b = await prompt(bus, "beta", "for beta");
    expect(a.promise_id).not.toBe(b.promise_id);

    bus.ingestSessionEvent(tailerEvent("alpha", "response.text", { text: "a" }));
    bus.ingestSessionEvent(tailerEvent("beta", "response.text", { text: "b" }));

    const texts = events.filter((e) => e.topic === "response.text");
    expect(texts).toHaveLength(2);
    expect(texts.find((e) => e.agent_id === "alpha")?.promise_id).toBe(a.promise_id);
    expect(texts.find((e) => e.agent_id === "beta")?.promise_id).toBe(b.promise_id);
  });

  it("does not mutate the event object the caller passed in", async () => {
    const { bus } = makeBus();
    await prompt(bus, "alpha", "hello");

    const mine = tailerEvent("alpha", "response.text", { text: "x" });
    bus.ingestSessionEvent(mine);

    expect(mine.promise_id).toBeUndefined();
  });

  it("leaves an event that already carries an id alone", async () => {
    const { bus, events } = makeBus();
    await prompt(bus, "alpha", "hello");

    const carried = {
      ...tailerEvent("alpha", "response.text", { text: "x" }),
      promise_id: "theirs",
    };
    bus.ingestSessionEvent(carried);

    const text = events.filter((e) => e.topic === "response.text");
    expect(text).toHaveLength(1);
    expect(text[0].promise_id).toBe("theirs");
  });

  it("leaves events outside any turn unstamped rather than guessing", () => {
    const { bus, events } = makeBus();

    // No prompt was ever sent for this agent.
    bus.ingestSessionEvent(tailerEvent("gamma", "session.init", { schema_version: 1 }));

    expect(events).toHaveLength(1);
    expect(events[0].promise_id).toBeUndefined();
  });

  // A turn that never reaches `response.turn_end` must still release the slot.
  // The origin slot next to it learned this the hard way (PR #138 review): a
  // slot left filled on an abnormal terminator attaches the dead turn's
  // identity to the NEXT turn. For an operation id that is worse than carrying
  // none — a client correlates confidently, and wrongly.
  describe("abnormal turn terminators release the slot", () => {
    function ipc(bus: BusCore, agent_id: string, msg: unknown): void {
      (bus as unknown as { handleIpcMessage(a: string, m: unknown): void }).handleIpcMessage(
        agent_id,
        msg,
      );
    }

    it("a cancelled turn does not stamp the next turn's events", async () => {
      const { bus, events } = makeBus();
      const cancelled = await prompt(bus, "alpha", "one");

      ipc(bus, "alpha", { type: "cancel", agent_id: "alpha", reason: "user stopped it" });
      bus.ingestSessionEvent(tailerEvent("alpha", "response.text", { text: "after cancel" }));

      const after = events.filter((e) => e.topic === "response.text");
      expect(after).toHaveLength(1);
      expect(after[0].promise_id).toBeUndefined();
      expect(after[0].promise_id).not.toBe(cancelled.promise_id);
    });

    it("an errored turn does not stamp the next turn's events", async () => {
      const { bus, events } = makeBus();
      const errored = await prompt(bus, "alpha", "one");

      ipc(bus, "alpha", { type: "error", agent_id: "alpha", code: "E", message: "boom" });
      bus.ingestSessionEvent(tailerEvent("alpha", "response.text", { text: "after error" }));

      const after = events.filter((e) => e.topic === "response.text");
      expect(after).toHaveLength(1);
      expect(after[0].promise_id).toBeUndefined();
      expect(after[0].promise_id).not.toBe(errored.promise_id);
    });

    it("keeps stamping across a final reply — the slot outlives it on purpose", async () => {
      // The origin slot IS released on `intent: "final"`. The operation slot
      // deliberately is not: `usage` and `response.turn_end` arrive after the
      // final reply and are exactly what a client needs correlated.
      const { bus, events } = makeBus();
      const op = await prompt(bus, "alpha", "one");

      bus.ingestReply({
        agent_id: "alpha",
        text: "done",
        intent: "final",
      } as Parameters<BusCore["ingestReply"]>[0]);
      bus.ingestSessionEvent(tailerEvent("alpha", "usage", { input_tokens: 1 }));
      bus.ingestSessionEvent(tailerEvent("alpha", "response.turn_end", { text: "done" }));

      const usage = events.filter((e) => e.topic === "usage");
      const turnEnd = events.filter((e) => e.topic === "response.turn_end");
      expect(usage[0]?.promise_id).toBe(op.promise_id);
      expect(turnEnd[0]?.promise_id).toBe(op.promise_id);
    });
  });

  it("documents the limit: a second prompt takes the slot, so correlation is advisory", async () => {
    // The boundary a control client must design against, asserted rather than
    // left to be discovered: the slot is per AGENT, not per operation.
    //
    // Overlapping prompts are the OBVIOUS case, shown here. The non-obvious
    // one is that sequential turns are not safe either — the tailer delivers
    // `response.turn_end` asynchronously, so a lagged turn_end can land after
    // the next prompt has taken the slot (#217 finding 3, deferred #239).
    // That is why the guarantee is ADVISORY and not "exact for sequential
    // turns": a client cannot detect the lag, so it cannot know which case
    // it is in.
    const { bus, events } = makeBus();
    const first = await prompt(bus, "alpha", "one");
    const second = await prompt(bus, "alpha", "two");

    bus.ingestSessionEvent(tailerEvent("alpha", "response.text", { text: "whose?" }));

    const text = events.filter((e) => e.topic === "response.text");
    expect(text).toHaveLength(1);
    expect(text[0].promise_id).toBe(second.promise_id);
    expect(text[0].promise_id).not.toBe(first.promise_id);
  });
});
