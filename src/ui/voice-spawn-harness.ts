/**
 * /api/voice-spawn-harness — endpoint claudeclaw qui spawn voice-code-fix-harness
 * en background sub-process.
 *
 * Pourquoi cet endpoint vs subprocess.Popen direct depuis greg-voice.py:
 *   - greg-voice.py tourne comme user `asterisk` (Asterisk AGI)
 *   - asterisk n'a pas accès au DBUS keyring de simon
 *   - Donc Claude Agent SDK / claude CLI échoue auth (pas OAuth)
 *   - Claudeclaw tourne comme `simon` avec DBUS hérité → spawn ici hérite tout
 *
 * Pattern Bun.serve natif (matche /api/inject + /api/voice-callback existants).
 *
 * À intégrer dans /home/simon/agent/claudeclaw/src/ui/server.ts:
 *   import { handleSpawnHarness } from "./voice-spawn-harness";
 *   if (url.pathname === "/api/voice-spawn-harness" && req.method === "POST") {
 *     return handleSpawnHarness(req, opts.getSnapshot().settings);
 *   }
 */

import { json } from "./http";
import { checkBearer } from "./auth";
import type { Settings } from "../config";
import { spawn } from "child_process";
import { existsSync } from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const HARNESS_PATH = "/home/simon/agent/scripts/voice-code-fix-harness.ts";
const BUN_PATH = "/home/simon/.bun/bin/bun";
const CALLBACK_URL = "http://localhost:4632/api/voice-callback";

// ─── Validation ──────────────────────────────────────────────────────────────

interface SpawnPayload {
  task_id: string;
  description: string;
  working_dir: string;
  model: string;
  cost_cap_usd: number;
  trader_critical?: boolean;
  session_key?: string;
}

function validate(raw: unknown): { ok: true; p: SpawnPayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "payload must be object" };
  const r = raw as Record<string, unknown>;

  if (typeof r.task_id !== "string" || r.task_id.length < 8) {
    return { ok: false, error: "task_id must be string >= 8 chars" };
  }
  if (typeof r.description !== "string" || !r.description.trim()) {
    return { ok: false, error: "description required" };
  }
  if (typeof r.working_dir !== "string" || !r.working_dir.trim()) {
    return { ok: false, error: "working_dir required" };
  }
  if (typeof r.model !== "string" || !r.model.trim()) {
    return { ok: false, error: "model required" };
  }
  if (typeof r.cost_cap_usd !== "number" || r.cost_cap_usd <= 0) {
    return { ok: false, error: "cost_cap_usd must be positive number" };
  }

  return {
    ok: true,
    p: {
      task_id: r.task_id,
      description: r.description.trim(),
      working_dir: r.working_dir.trim(),
      model: r.model.trim(),
      cost_cap_usd: r.cost_cap_usd,
      trader_critical: r.trader_critical === true,
      session_key: typeof r.session_key === "string" ? r.session_key : `voice-spawn-${r.task_id}`,
    },
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleSpawnHarness(req: Request, settings: Settings): Promise<Response> {
  // Auth
  const authErr = checkBearer(req, settings.apiToken);
  if (authErr) return authErr;

  // Pre-check: harness file exists
  if (!existsSync(HARNESS_PATH)) {
    return json({ ok: false, error: `harness not found: ${HARNESS_PATH}` }, 500);
  }
  if (!existsSync(BUN_PATH)) {
    return json({ ok: false, error: `bun not found: ${BUN_PATH}` }, 500);
  }

  // Parse + validate
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  const v = validate(raw);
  if (!v.ok) return json({ ok: false, error: v.error }, 400);
  const p = v.p;

  // Build args for harness
  const args: string[] = [
    "run",
    HARNESS_PATH,
    "--task-id",      p.task_id,
    "--description",  p.description,
    "--working-dir",  p.working_dir,
    "--model",        p.model,
    "--cost-cap-usd", String(p.cost_cap_usd),
    "--callback-url", CALLBACK_URL,
    "--session-key",  p.session_key!,
  ];
  if (p.trader_critical) args.push("--trader-critical");

  // Spawn detached. We inherit our own env (DBUS, OAuth credentials path, etc.)
  // so the harness's Claude SDK calls authenticate via OAuth keyring.
  // cwd = claudeclaw root so bun resolves @anthropic-ai/claude-agent-sdk via
  // claudeclaw/node_modules (the harness file lives outside, in agent/scripts).
  let pid: number | undefined;
  try {
    const child = spawn(BUN_PATH, args, {
      detached: true,
      stdio: "ignore",
      cwd: "/home/simon/agent/claudeclaw",
      env: process.env,
    });
    pid = child.pid;
    child.unref();
  } catch (e) {
    return json({ ok: false, error: `spawn failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }

  console.log(`[voice-spawn-harness] task=${p.task_id} model=${p.model} pid=${pid} workdir=${p.working_dir}`);

  return json({
    ok: true,
    pid,
    task_id: p.task_id,
    spawned: true,
    callback_url: CALLBACK_URL,
  });
}
