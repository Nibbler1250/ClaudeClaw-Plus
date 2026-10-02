import { readFile } from "fs/promises";
import { peekSession } from "../../sessions";
import { SESSION_FILE, SETTINGS_FILE, STATE_FILE } from "../constants";
import type { WebSnapshot } from "../types";

export function sanitizeSettings(snapshot: WebSnapshot["settings"]) {
  return {
    timezone: snapshot.timezone,
    timezoneOffsetMinutes: snapshot.timezoneOffsetMinutes,
    heartbeat: snapshot.heartbeat,
    security: snapshot.security,
    telegram: {
      configured: Boolean(snapshot.telegram.token),
      allowedUserCount: snapshot.telegram.allowedUserIds.length,
    },
    discord: {
      configured: Boolean(snapshot.discord.token),
      allowedUserCount: snapshot.discord.allowedUserIds.length,
    },
    web: snapshot.web,
  };
}

export async function buildState(snapshot: WebSnapshot) {
  const now = Date.now();
  const session = await peekSession();
  return {
    daemon: {
      running: true,
      pid: snapshot.pid,
      startedAt: snapshot.startedAt,
      uptimeMs: now - snapshot.startedAt,
    },
    heartbeat: {
      enabled: snapshot.settings.heartbeat.enabled,
      intervalMinutes: snapshot.settings.heartbeat.interval,
      nextAt: snapshot.heartbeatNextAt || null,
      nextInMs: snapshot.heartbeatNextAt ? Math.max(0, snapshot.heartbeatNextAt - now) : null,
    },
    jobs: snapshot.jobs.map((j) => ({
      name: j.name,
      schedule: j.schedule,
      prompt: j.prompt,
    })),
    security: snapshot.settings.security,
    telegram: {
      configured: Boolean(snapshot.settings.telegram.token),
      allowedUserCount: snapshot.settings.telegram.allowedUserIds.length,
    },
    discord: {
      configured: Boolean(snapshot.settings.discord.token),
      allowedUserCount: snapshot.settings.discord.allowedUserIds.length,
    },
    session: session
      ? {
          sessionIdShort: session.sessionId?.slice(0, 8) ?? "no-session",
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
        }
      : null,
    web: snapshot.settings.web,
  };
}

/**
 * Field names whose values are secrets and must never leave the daemon
 * unredacted. Matched case-insensitively against every key at every
 * depth (issue #164 item 5, ported from upstream #185). The previous
 * implementation only redacted a hand-enumerated set of top-level +
 * one-level-nested fields, so a secret under a new/renamed key (or
 * deeper nesting) would leak through `/api/technical-info`.
 *
 * A key is a secret when it *ends* in a secret-shaped word (#510): an
 * exact-name list let `slack.signingSecret` through while `botToken` next
 * to it was redacted. Plurals count (`apiKeys`, `secrets`, but not
 * `tokens`: that is `maxTokens`), and so do `credentials`, `passphrase`
 * and an `Authorization` header. `api` is the one bare name kept (the
 * GLM key). Erring on the side of hiding a
 * non-secret (`cacheKey`) is the intended trade-off on a debug endpoint.
 */
const SECRET_KEY_SUFFIX =
  /(token|secrets?|keys?|passwords?|passwd|passphrase|credentials?|authorization|cookies?)$/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_SUFFIX.test(key) || key.toLowerCase() === "api";
}

/**
 * Recursively replace any field whose name matches {@link isSecretKey}
 * with `<redacted:N chars>` (N = original string length, or `0` for
 * empty/non-string). Returns a deep copy — never mutates the input.
 * Arrays are walked element-wise; primitives pass through untouched.
 */
function redactSettings(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(redactSettings);
  if (!raw || typeof raw !== "object") return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isSecretKey(key)) {
      const len = typeof value === "string" ? value.length : 0;
      out[key] = `<redacted:${len} chars>`;
    } else {
      out[key] = redactSettings(value);
    }
  }
  return out;
}

export async function buildTechnicalInfo(snapshot: WebSnapshot) {
  const rawSettings = await readJsonFile(SETTINGS_FILE);
  return {
    daemon: {
      pid: snapshot.pid,
      startedAt: snapshot.startedAt,
      uptimeMs: Math.max(0, Date.now() - snapshot.startedAt),
    },
    files: {
      settingsJson: redactSettings(rawSettings),
      sessionJson: await readJsonFile(SESSION_FILE),
      stateJson: await readJsonFile(STATE_FILE),
    },
    snapshot: {
      ...snapshot,
      settings: redactSettings(snapshot.settings) as WebSnapshot["settings"],
    },
  };
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
