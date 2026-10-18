import type { OneShotEngine } from "./engine";
import { printEngine } from "./print";
import { ptyEngine } from "./pty";
import type { OneShotSettings } from "./settings";

/** The engines every install has. Keyed by id; `oneShot.engines` aliases them. */
export const BUILTIN_ENGINES: Readonly<Record<string, OneShotEngine>> = Object.freeze({
  [printEngine.id]: printEngine,
  [ptyEngine.id]: ptyEngine,
});

/** Every registered engine. The contract tests loop over this list. */
export function listEngines(): OneShotEngine[] {
  return Object.values(BUILTIN_ENGINES);
}

/** The engine `id` names under `settings`, built-in or declared. Throws if none. */
export function getEngine(settings: OneShotSettings, id: string): OneShotEngine {
  const type = Object.hasOwn(BUILTIN_ENGINES, id)
    ? id
    : Object.hasOwn(settings.engines, id)
      ? settings.engines[id]?.type
      : undefined;
  const engine = type && Object.hasOwn(BUILTIN_ENGINES, type) ? BUILTIN_ENGINES[type] : undefined;
  if (!engine) throw new Error(`oneshot: unknown engine ${id}`);
  return engine;
}
