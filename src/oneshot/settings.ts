import type { OneShotEngine } from "./engine";
import { BUILTIN_ENGINES } from "./registry";
import { ROUTES } from "./routes";

/**
 * `settings.oneShot`. `default` is the engine of any route not listed in
 * `routes`; `engines` names extra engines by the built-in they run on.
 */
export interface OneShotSettings {
  default: string;
  engines: Record<string, { type: string }>;
  routes: Record<string, string>;
}

/** Absent block: every route on `print`, as before #548. */
export const DEFAULT_ONESHOT_SETTINGS: OneShotSettings = Object.freeze({
  default: "print",
  engines: Object.freeze({}) as Record<string, { type: string }>,
  routes: Object.freeze({}) as Record<string, string>,
});

/** Own keys only: `constructor` or `toString` are not engines or routes. */
const has = (o: object, k: string): boolean => Object.hasOwn(o, k);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses and checks `settings.oneShot`. Throws on anything it cannot honour —
 * an unknown engine or route, a resume route on an engine that cannot resume,
 * an untrusted route on an engine that cannot isolate — so a bad mapping stops
 * the load instead of failing on the first call. `builtins` is the engine
 * table to check against (tests pass their own).
 */
export function parseOneShotSettings(
  raw: unknown,
  builtins: Readonly<Record<string, OneShotEngine>> = BUILTIN_ENGINES,
): OneShotSettings {
  if (raw === undefined) return DEFAULT_ONESHOT_SETTINGS;
  if (!isRecord(raw)) throw new Error("settings.oneShot must be an object");

  const engines: Record<string, { type: string }> = {};
  if (raw.engines !== undefined) {
    if (!isRecord(raw.engines)) throw new Error("settings.oneShot.engines must be an object");
    for (const [name, def] of Object.entries(raw.engines)) {
      const type = isRecord(def) ? def.type : undefined;
      if (typeof type !== "string" || !has(builtins, type)) {
        throw new Error(
          `settings.oneShot.engines.${name}.type must be one of: ${Object.keys(builtins).join(", ")}`,
        );
      }
      if (has(builtins, name)) {
        throw new Error(`settings.oneShot.engines.${name} redefines a built-in engine`);
      }
      engines[name] = { type };
    }
  }
  const typeOf = (id: string): string | undefined =>
    has(builtins, id) ? id : has(engines, id) ? engines[id]?.type : undefined;

  const def = raw.default === undefined ? "print" : raw.default;
  if (typeof def !== "string" || !typeOf(def)) {
    throw new Error(`settings.oneShot.default: unknown engine ${JSON.stringify(def)}`);
  }

  const routes: Record<string, string> = {};
  if (raw.routes !== undefined) {
    if (!isRecord(raw.routes)) throw new Error("settings.oneShot.routes must be an object");
    for (const [route, id] of Object.entries(raw.routes)) {
      if (!has(ROUTES, route)) throw new Error(`settings.oneShot.routes: unknown route ${route}`);
      if (typeof id !== "string" || !typeOf(id)) {
        throw new Error(`settings.oneShot.routes.${route}: unknown engine ${JSON.stringify(id)}`);
      }
      routes[route] = id;
    }
  }

  // Every route, mapped or defaulted, must land on an engine that can run it.
  for (const [route, need] of Object.entries(ROUTES)) {
    const id = routes[route] ?? def;
    const caps = builtins[typeOf(id) as string]?.caps;
    if (!caps) throw new Error(`settings.oneShot: no engine ${id}`);
    if (need.resume && !caps.resume) {
      throw new Error(`settings.oneShot: route ${route} resumes a session; engine ${id} cannot`);
    }
    if (need.isolation === "untrusted" && !caps.isolation) {
      throw new Error(
        `settings.oneShot: route ${route} reads untrusted text; engine ${id} cannot run it isolated`,
      );
    }
  }
  return { default: def, engines, routes };
}
