/**
 * /api/voice-callback — endpoint Greg/claudeclaw qui reçoit les callbacks
 * POST des sub-agents async (voice-code-fix, futurs voice-* background skills).
 *
 * Pattern Bun.serve natif (matche /api/inject existant).
 * Auth via checkBearer + settings.apiToken (settings.json, pas env var).
 * Telegram via settings.telegram (settings.json, pas env var).
 *
 * À intégrer dans /home/simon/agent/claudeclaw/src/ui/server.ts.
 */

import { json } from "./http";
import { checkBearer } from "./auth";
import type { Settings } from "../config";
import { appendFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

type CallbackStatus =
  | "success"
  | "failed"
  | "needs_human_repro"
  | "blocked_market_hours"
  | "blocked_dirty_tree"
  | "blocked_no_workdir"
  | "blocked_not_git"
  | "blocked_no_test_runner"
  | "cost_cap_exceeded";

interface CallbackPayload {
  task_id: string;
  status: CallbackStatus;
  intent: string;
  branch?: string;
  pr_url?: string;
  pr_number?: number;
  tests_run?: number;
  tests_passed?: number;
  files_changed?: string[];
  diff_summary?: string;
  cost_actual_usd?: number;
  model_used?: string;
  duration_sec?: number;
  trader_critical?: boolean;
  voice_summary: string;
  debug?: Record<string, unknown>;
}

// ─── Validation (lightweight, pas Zod pour éviter la dep) ────────────────────

function validatePayload(raw: unknown): { ok: true; payload: CallbackPayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "payload must be an object" };
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.task_id !== "string" || r.task_id.length < 8) {
    return { ok: false, error: "task_id must be string >= 8 chars" };
  }
  const VALID_STATUS: CallbackStatus[] = [
    "success", "failed", "needs_human_repro",
    "blocked_market_hours", "blocked_dirty_tree", "blocked_no_workdir",
    "blocked_not_git", "blocked_no_test_runner", "cost_cap_exceeded",
  ];
  if (typeof r.status !== "string" || !VALID_STATUS.includes(r.status as CallbackStatus)) {
    return { ok: false, error: `status must be one of: ${VALID_STATUS.join(", ")}` };
  }
  if (typeof r.intent !== "string") {
    return { ok: false, error: "intent must be string" };
  }
  if (typeof r.voice_summary !== "string" || !r.voice_summary.trim()) {
    return { ok: false, error: "voice_summary must be non-empty string" };
  }

  return { ok: true, payload: r as unknown as CallbackPayload };
}

// ─── Telegram message formatting ─────────────────────────────────────────────

const STATUS_EMOJI: Record<CallbackStatus, string> = {
  success: "✅",
  failed: "❌",
  needs_human_repro: "❓",
  blocked_market_hours: "⏰",
  blocked_dirty_tree: "🚧",
  blocked_no_workdir: "📂",
  blocked_not_git: "📂",
  blocked_no_test_runner: "🧪",
  cost_cap_exceeded: "💸",
};

function formatTelegramMessage(p: CallbackPayload): string {
  const emoji = STATUS_EMOJI[p.status] ?? "ℹ️";
  const lines: string[] = [`${emoji} *${p.intent}* — task \`${p.task_id.slice(0, 8)}\``, "", p.voice_summary];

  if (p.status === "success" && p.pr_url) {
    lines.push("", `🔗 ${p.pr_url}`);
    if (p.tests_passed !== undefined && p.tests_run !== undefined) {
      lines.push(`🧪 ${p.tests_passed}/${p.tests_run} tests`);
    }
    if (p.files_changed && p.files_changed.length > 0) {
      const list = p.files_changed.slice(0, 3).join(", ");
      const more = p.files_changed.length > 3 ? "..." : "";
      lines.push(`📝 ${p.files_changed.length} file(s): ${list}${more}`);
    }
  }

  if (p.cost_actual_usd !== undefined && p.model_used) {
    const cost = p.cost_actual_usd.toFixed(2);
    const dur = p.duration_sec ? ` · ${Math.round(p.duration_sec)}s` : "";
    lines.push("", `_${p.model_used} · $${cost}${dur}_`);
  }

  if (p.status === "failed" && p.debug?.stderr) {
    const stderr = String(p.debug.stderr).slice(0, 400);
    lines.push("", "```", stderr, "```");
  }

  return lines.join("\n");
}

async function sendTelegram(settings: Settings, text: string): Promise<void> {
  const { token, allowedUserIds } = settings.telegram;
  if (!token || !allowedUserIds || allowedUserIds.length === 0) {
    console.warn("[voice-callback] telegram not configured in settings, skip");
    return;
  }
  const chatId = allowedUserIds[0];
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[voice-callback] Telegram failed (${res.status}): ${body}`);
    }
  } catch (e) {
    console.error("[voice-callback] Telegram error:", e);
  }
}

// ─── Voice log persistence ───────────────────────────────────────────────────

const VOICE_LOG_DIR = "/var/lib/asterisk-voice";

async function appendVoiceLog(entry: Record<string, unknown>): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const file = join(VOICE_LOG_DIR, `${date}.jsonl`);
  try {
    await mkdir(dirname(file), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await appendFile(file, line, "utf8");
  } catch (e) {
    console.error("[voice-callback] voice-log write failed:", e);
  }
}

// ─── Main handler (à appeler depuis server.ts dans le if/else chain) ─────────

export async function handleVoiceCallback(req: Request, settings: Settings): Promise<Response> {
  // Auth
  const authErr = checkBearer(req, settings.apiToken);
  if (authErr) return authErr;

  // Parse JSON
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  // Validate
  const v = validatePayload(raw);
  if (!v.ok) {
    return json({ ok: false, error: v.error }, 400);
  }
  const p = v.payload;

  // 1. Persist voice-log (always)
  await appendVoiceLog({
    role: "callback",
    task_id: p.task_id,
    status: p.status,
    intent: p.intent,
    cost_actual_usd: p.cost_actual_usd,
    model_used: p.model_used,
    duration_sec: p.duration_sec,
    pr_url: p.pr_url,
  });

  // 2. Telegram dispatch
  const message = formatTelegramMessage(p);
  await sendTelegram(settings, message);

  // 3. Outbound call escalation (futur, gated par env)
  if (p.status === "failed" && p.trader_critical && process.env.TWILIO_OUTBOUND_ENABLED === "true") {
    console.log(`[voice-callback] TODO: escalate via call (task ${p.task_id})`);
    // TODO: wire Twilio API call quand activé
  }

  return json({ ok: true, dispatched: ["telegram", "voice-log"] });
}

// ─── Wiring instructions ─────────────────────────────────────────────────────
//
// Dans server.ts, importer en haut:
//   import { handleVoiceCallback } from "./voice-callback";
//
// Dans le if/else chain (après /api/inject par exemple):
//
//   if (url.pathname === "/api/voice-callback" && req.method === "POST") {
//     return handleVoiceCallback(req, opts.getSnapshot().settings);
//   }
