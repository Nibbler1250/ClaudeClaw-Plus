/**
 * One-shot `claude` calls (#548): one request shape, one isolation rule, and
 * the engine for each call picked by route from the `oneShot` settings.
 */
import type { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEngine } from "./registry";
import { ROUTES } from "./routes";
import { DEFAULT_ONESHOT_SETTINGS, type OneShotSettings } from "./settings";

export type OneShotIsolation = "untrusted" | "trusted-session";

export interface OneShotRequest {
  /** Who is calling, e.g. `discord.classifier`. Picks the engine. */
  route: string;
  prompt: string;
  /** Replaces the CLI's system prompt (`print`), or leads the prompt (`pty`). */
  system?: string;
  model?: string;
  /** No default: every caller states whether the prompt carries untrusted text. */
  isolation: OneShotIsolation;
  /** `trusted-session` only. */
  resumeSessionId?: string;
  /** `trusted-session` only. */
  allowedTools?: string[];
  /** Not forwarded by the claude engines: the CLI has no output-length flag. */
  maxTokens?: number;
  /** Bounds the whole call. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Child env for the `print` engine. Default: `cleanSpawnEnv()`. */
  env?: Record<string, string>;
}

export interface OneShotResult {
  /** Model output, trimmed. */
  text: string;
  engine: string;
  model?: string;
  /** 0 on success. 124: timed out. 130: aborted. */
  exitCode: number;
  stderr: string;
  sessionId?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface OneShotEngineCaps {
  /** Can continue a saved session (`resumeSessionId`). */
  resume: boolean;
  /** Honours `allowedTools`. */
  tools: boolean;
  /** Can run `isolation: "untrusted"`. */
  isolation: boolean;
}

export type SpawnFn = typeof spawn;

export interface OneShotContext {
  /** Set for untrusted calls: an empty temp dir, removed after the call. */
  cwd?: string;
  spawn: SpawnFn;
}

export interface OneShotEngine {
  id: string;
  caps: OneShotEngineCaps;
  run(req: OneShotRequest, ctx: OneShotContext): Promise<Omit<OneShotResult, "engine">>;
}

export interface RunOneShotOptions {
  /** Default: the loaded daemon settings, else every route on `print`. */
  settings?: OneShotSettings;
  /** Process spawner for the `print` engine. Default: `node:child_process`. */
  spawn?: SpawnFn;
}

async function currentSettings(): Promise<OneShotSettings> {
  try {
    // Lazy: the tuner CLI calls this without the daemon's settings loaded.
    const { getSettings } = await import("../config");
    return getSettings().oneShot ?? DEFAULT_ONESHOT_SETTINGS;
  } catch {
    return DEFAULT_ONESHOT_SETTINGS;
  }
}

/** The engine id a route runs on under `settings`. */
export function engineIdFor(route: string, settings: OneShotSettings): string {
  return (Object.hasOwn(settings.routes, route) && settings.routes[route]) || settings.default;
}

/** Refuses what an engine or the isolation rule cannot honour. Throws. */
export function checkRequest(req: OneShotRequest, engine: OneShotEngine): void {
  // Unknown routes are refused: the route is what says a caller reads untrusted text.
  if (!Object.hasOwn(ROUTES, req.route)) throw new Error(`oneshot: unknown route ${req.route}`);
  if (ROUTES[req.route]?.isolation === "untrusted" && req.isolation !== "untrusted") {
    throw new Error(`oneshot: route ${req.route} reads untrusted text and must run isolated`);
  }
  if (req.isolation === "untrusted") {
    if (req.resumeSessionId) throw new Error("oneshot: an untrusted call cannot resume a session");
    if (req.allowedTools) throw new Error("oneshot: an untrusted call cannot be given tools");
    if (!engine.caps.isolation) {
      throw new Error(`oneshot: engine ${engine.id} cannot run untrusted route ${req.route}`);
    }
  }
  if (req.resumeSessionId && !engine.caps.resume) {
    throw new Error(`oneshot: engine ${engine.id} cannot resume a session`);
  }
  if (req.allowedTools && !engine.caps.tools) {
    throw new Error(`oneshot: engine ${engine.id} does not take allowedTools`);
  }
}

/**
 * Runs one call on the engine its route maps to. An untrusted call runs in an
 * empty temp cwd, removed whatever the outcome. Logs one line per call.
 */
export async function runOneShot(
  req: OneShotRequest,
  opts: RunOneShotOptions = {},
): Promise<OneShotResult> {
  const settings = opts.settings ?? (await currentSettings());
  const started = Date.now();
  let engineId = engineIdFor(req.route, settings);
  let cwd: string | undefined;
  let exitCode: number | "error" | "refused" = "refused";
  let usage: OneShotResult["usage"];
  try {
    const engine = getEngine(settings, engineId);
    engineId = engine.id;
    checkRequest(req, engine);
    exitCode = "error";
    if (req.isolation === "untrusted") cwd = mkdtempSync(join(tmpdir(), "claudeclaw-oneshot-"));
    let spawnFn = opts.spawn;
    if (!spawnFn) spawnFn = (await import("node:child_process")).spawn;
    const out = await engine.run(req, { spawn: spawnFn, ...(cwd ? { cwd } : {}) });
    exitCode = out.exitCode;
    usage = out.usage;
    return { ...out, engine: engine.id };
  } finally {
    if (cwd) {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // A failed removal (Windows file lock) must not replace the result.
      }
    }
    const tokens =
      usage?.inputTokens !== undefined || usage?.outputTokens !== undefined
        ? ` in=${usage?.inputTokens ?? "?"} out=${usage?.outputTokens ?? "?"}`
        : "";
    console.log(
      `[oneshot] route=${req.route} engine=${engineId} model=${req.model?.trim() || "default"} isolation=${req.isolation} ms=${Date.now() - started} exit=${exitCode}${tokens}`,
    );
  }
}
