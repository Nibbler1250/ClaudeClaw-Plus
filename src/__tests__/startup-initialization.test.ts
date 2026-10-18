import { describe, expect, it } from "bun:test";
import { beginStartupInitialization } from "../startup-initialization.js";

describe("background startup initialization", () => {
  it("a never-completing bootstrap does not delay the next startup step", async () => {
    const order: string[] = [];
    const logs: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        beginStartupInitialization({
          bootstrap: () => {
            order.push("bootstrap");
            return new Promise(() => {});
          },
          next: () => {
            order.push("preflight");
          },
          logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("startup continuation delayed")), 40);
        }),
      ]);
      expect(order).toEqual(["bootstrap", "preflight"]);
      expect(logs).toEqual([]);
    } finally {
      clearTimeout(timer);
    }
  });
  it("logs background success and failure without delaying continuation", async () => {
    for (const failed of [false, true]) {
      const messages: string[] = [];
      let next = false;
      await beginStartupInitialization({
        bootstrap: async () => {
          if (failed) throw new Error("exit 124");
        },
        next: () => {
          next = true;
        },
        logger: { info: (line) => messages.push(line), warn: (line) => messages.push(line) },
      });
      await Promise.resolve();
      expect(next).toBe(true);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(failed ? "failed" : "completed");
    }
  });
});
