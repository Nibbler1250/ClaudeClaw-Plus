import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBusCore } from "../core.js";
import { PtyAgentProcess, type PtyHandle } from "../session-agent-process.js";
import { createPromptStreamHandler, unwrapChannelText } from "../receipt-wiring.js";
import { createReceiptStore, hashPrompt, type OpenReceipt } from "../receipt.js";
import { deliverAgentJobResult } from "../runtime-mount.js";
import { defaultSupervisionFor, type PromptDeliveryOutcome } from "../types.js";

describe("#550 non-channel PTY delivery", () => {
  for (const source of ["cron", "agent-job"] as const) {
    it(`${source} reaches the #361 loop and confirms from actual prompt ingestion`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "pty-delivery-"));
      const writes: string[] = [];
      let emit: (data: string) => void = () => {};
      let proc: PtyAgentProcess;
      const handle: PtyHandle = {
        pid: 550,
        onData: (cb) => {
          emit = cb;
          return { dispose() {} };
        },
        onExit: () => ({ dispose() {} }),
        kill: () => {},
        write: (data) => {
          writes.push(data);
          if (data === "\r") {
            // The fake CLI records the submitted text, not merely its CR.
            setTimeout(
              () =>
                proc.notePromptIngested({
                  text: writes[0]!,
                  source: "user",
                  promptId: `pid-${source}`,
                  ingestedAtMs: Date.now(),
                }),
              2,
            );
          }
        },
      };
      proc = new PtyAgentProcess("default", handle, {
        submitConfirmMs: 10,
        transcriptGraceMs: 1000,
        bootDialogMaxMs: 100,
      });
      proc.enableTranscriptConfirmation();
      emit("bypass permissions on (shift+tab to cycle)");
      expect(defaultSupervisionFor("cron")).toBe(proc.supervision);
      const store = createReceiptStore({ path: join(dir, "receipts.jsonl") });
      let receipt: OpenReceipt | undefined;
      let finish!: (outcome: PromptDeliveryOutcome | void) => void;
      const delivered = new Promise<PromptDeliveryOutcome | void>((resolve) => {
        finish = resolve;
      });
      const handler = createPromptStreamHandler(() => proc, { store });
      const bus = createBusCore({ eventLogAppend: (async () => ({})) as never, replyNudge: false });
      bus.setStreamPromptHandler(async (id, text) => {
        receipt = store.open(`receipt-${source}`, {
          agent_id: id,
          prompt_hash: hashPrompt(unwrapChannelText(text)),
        });
        const outcome = await handler(id, text);
        finish(outcome);
        return outcome;
      });
      try {
        if (source === "cron") {
          await bus.sendPrompt({
            agent_id: "default",
            origin: "cron",
            origin_id: "nightly",
            user_id: "system",
            text: "run the nightly report",
          });
        } else {
          // Agent jobs use the existing cron bus origin and agent-job: id.
          deliverAgentJobResult(
            bus,
            {
              jobId: "job-550",
              agent: "worker",
              dispatcher: "default",
              status: "done",
              createdAt: 0,
              resultText: "job complete",
            },
            { warn: () => {} },
          );
        }
        expect(await delivered).toBe("turn-started");
        expect(receipt?.record.notes?.delivery_outcome).toBe("turn-started");
        expect(writes.filter((value) => value === "\r")).toHaveLength(1);
        expect(writes[0]).toContain('source="cron"');
        expect(writes[0]).toContain(
          source === "cron" ? 'chat_id="nightly"' : 'chat_id="agent-job:job-550"',
        );
      } finally {
        await bus.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
