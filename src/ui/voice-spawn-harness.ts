/**
 * /api/voice-spawn-harness — endpoint claudeclaw qui spawn les harnesses
 * voice en background. Route selon le champ `harness` du payload:
 *   - "code-fix" (default) → voice-code-fix-harness.ts (TS + Claude SDK)
 *   - "archiviste"          → voice-archiviste-harness.py (Python)
 *
 * Pourquoi cet endpoint vs subprocess.Popen direct depuis greg-voice.py:
 *   - greg-voice.py tourne comme user `asterisk` (Asterisk AGI)
 *   - asterisk n'a pas accès au DBUS keyring de simon
 *   - Donc Claude Agent SDK / claude CLI échoue auth (pas OAuth)
 *   - Claudeclaw tourne comme `simon` avec DBUS hérité → spawn ici hérite tout
 */

import { json } from "./http";
import { checkBearer } from "./auth";
import type { Settings } from "../config";
import { spawn } from "child_process";
import { existsSync } from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const BUN_PATH = "/home/simon/.bun/bin/bun";
const PYTHON_PATH = "/usr/bin/python3";
const CALLBACK_URL = "http://localhost:4632/api/voice-callback";

const HARNESSES = {
  "code-fix": {
    interpreter: BUN_PATH,
    interpreterArgs: ["run"],
    script: "/home/simon/agent/scripts/voice-code-fix-harness.ts",
    cwd: "/home/simon/agent/claudeclaw", // node_modules resolution
    requiredFields: ["working_dir", "model", "cost_cap_usd"] as const,
  },
  "archiviste": {
    interpreter: PYTHON_PATH,
    interpreterArgs: [],
    script: "/home/simon/agent/scripts/voice-archiviste-harness.py",
    cwd: "/home/simon/agent",
    requiredFields: [] as const, // query is reused from description
  },
} as const;

type HarnessKey = keyof typeof HARNESSES;

// ─── Validation ──────────────────────────────────────────────────────────────

interface SpawnPayload {
  task_id: string;
  description: string;
  harness: HarnessKey;
  working_dir?: string;
  model?: string;
  cost_cap_usd?: number;
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

  // Default harness = code-fix (backward compatible)
  const harness = (typeof r.harness === "string" ? r.harness : "code-fix") as HarnessKey;
  if (!(harness in HARNESSES)) {
    return { ok: false, error: `harness must be one of: ${Object.keys(HARNESSES).join(", ")}` };
  }
  const cfg = HARNESSES[harness];

  // Per-harness required-field check
  for (const field of cfg.requiredFields) {
    const v = (r as any)[field];
    if (field === "cost_cap_usd") {
      if (typeof v !== "number" || v <= 0) {
        return { ok: false, error: `${field} required and must be positive number for ${harness}` };
      }
    } else if (typeof v !== "string" || !v.trim()) {
      return { ok: false, error: `${field} required for harness=${harness}` };
    }
  }

  return {
    ok: true,
    p: {
      task_id: r.task_id,
      description: r.description.trim(),
      harness,
      working_dir: typeof r.working_dir === "string" ? r.working_dir.trim() : undefined,
      model: typeof r.model === "string" ? r.model.trim() : undefined,
      cost_cap_usd: typeof r.cost_cap_usd === "number" ? r.cost_cap_usd : undefined,
      trader_critical: r.trader_critical === true,
      session_key: typeof r.session_key === "string" ? r.session_key : `voice-spawn-${r.task_id}`,
    },
  };
}

// ─── Build args per harness ──────────────────────────────────────────────────

function buildArgs(p: SpawnPayload): string[] {
  const cfg = HARNESSES[p.harness];
  const args: string[] = [...cfg.interpreterArgs, cfg.script];

  if (p.harness === "code-fix") {
    args.push(
      "--task-id", p.task_id,
      "--description", p.description,
      "--working-dir", p.working_dir!,
      "--model", p.model!,
      "--cost-cap-usd", String(p.cost_cap_usd!),
      "--callback-url", CALLBACK_URL,
      "--session-key", p.session_key!,
    );
    if (p.trader_critical) args.push("--trader-critical");
  } else if (p.harness === "archiviste") {
    args.push(
      "--task-id", p.task_id,
      "--query", p.description,
      "--top-k", "5",
      "--callback-url", CALLBACK_URL,
      "--session-key", p.session_key!,
    );
  }

  return args;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleSpawnHarness(req: Request, settings: Settings): Promise<Response> {
  // Auth
  const authErr = checkBearer(req, settings.apiToken);
  if (authErr) return authErr;

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

  const cfg = HARNESSES[p.harness];

  // Pre-checks
  if (!existsSync(cfg.script)) {
    return json({ ok: false, error: `script not found: ${cfg.script}` }, 500);
  }
  if (!existsSync(cfg.interpreter)) {
    return json({ ok: false, error: `interpreter not found: ${cfg.interpreter}` }, 500);
  }

  const args = buildArgs(p);

  // Spawn detached. Inherit env (DBUS, etc.) so Claude OAuth works in code-fix harness.
  let pid: number | undefined;
  try {
    const child = spawn(cfg.interpreter, args, {
      detached: true,
      stdio: "ignore",
      cwd: cfg.cwd,
      env: process.env,
    });
    pid = child.pid;
    child.unref();
  } catch (e) {
    return json({ ok: false, error: `spawn failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }

  console.log(`[voice-spawn-harness] harness=${p.harness} task=${p.task_id} pid=${pid}`);

  return json({
    ok: true,
    pid,
    task_id: p.task_id,
    harness: p.harness,
    spawned: true,
    callback_url: CALLBACK_URL,
  });
}
