import type { OneShotIsolation } from "./engine";

export interface OneShotRoute {
  isolation: OneShotIsolation;
  /** Continues a saved session, so its engine needs `caps.resume`. */
  resume: boolean;
}

/** Every one-shot caller. `oneShot.routes` may only name these. */
export const ROUTES: Readonly<Record<string, OneShotRoute>> = Object.freeze({
  compact: { isolation: "trusted-session", resume: true },
  "memory.save.precompact": { isolation: "trusted-session", resume: true },
  "memory.save.stop": { isolation: "trusted-session", resume: true },
  "rotation.summary": { isolation: "trusted-session", resume: true },
  "discord.classifier": { isolation: "untrusted", resume: false },
  "tuner.classify": { isolation: "untrusted", resume: false },
  "tuner.detect": { isolation: "untrusted", resume: false },
  "tuner.propose": { isolation: "untrusted", resume: false },
  "tuner.judge": { isolation: "untrusted", resume: false },
  "memory.recall": { isolation: "untrusted", resume: false },
});
