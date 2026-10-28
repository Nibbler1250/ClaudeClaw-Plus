// Daemon plugin for the soak harness. It holds no turn logic of its own: it calls functions the daemon has
// already loaded (same absolute path => same module instance). The pilot drops trigger files into
// <triggerDir>/<id>.<kind>; the plugin answers in <outDir>/<id>.json.
//   <id>.chat      {prompt}           -> runUserMessage("soak-chat", prompt)   (runner PTY "global", MCP from .mcp.json)
//   <id>.fake      {prompt}           -> NO turn; exitCode 0 + nonce (detector proof)
//   <id>.killturn  {prompt, delayMs}  -> runner turn, killActiveReport() after delayMs (scenario a)
//   <id>.retire    {key}              -> retirePtySession(key || "global") (scenario f, runner)
//   <id>.busclear  {agent}            -> SessionManager.clearSession(agent) (scenario c)
//   <id>.busretire {agent}            -> SessionManager.restart(agent) = retire + respawn (scenario f, bus)
//   <id>.oneshot   {route, prompt}    -> runOneShot({route, isolation:"untrusted"}), the call the tuner's one-shot backend makes
//   <id>.state     {}                 -> snapshotSupervisor() + groupUnconfirmedObservedCount() + bus health
// SessionManager has no global accessor: the instance is captured by wrapping getAgent/health/recordingPending.
//
// Paths come from the plugin config in settings.json (written by soak/setup.sh):
//   { "triggerDir": ..., "outDir": ..., "repoSrc": ... }
// with SOAK_BASE / SOAK_RESULTS / SOAK_REPO environment fallbacks.
import { readdir, readFile, rename, writeFile, mkdir } from "node:fs/promises";

let TRIGGER = null;
let OUT = null;
let R = null;
let SM = null;

function configure(cfg) {
  const env = process.env;
  const base = env.SOAK_BASE || null;
  TRIGGER = cfg.triggerDir || (base ? `${base}/trigger` : null);
  OUT = cfg.outDir || (env.SOAK_RESULTS ? `${env.SOAK_RESULTS}/plugin` : base ? `${base}/results/plugin` : null);
  R = cfg.repoSrc || (env.SOAK_REPO ? `${env.SOAK_REPO}/src` : null);
  if (!TRIGGER || !OUT || !R) throw new Error("soak-trigger: triggerDir, outDir and repoSrc must be set in the plugin config");
}

function capture(SessionManager) {
  for (const m of ["getAgent", "health", "recordingPending"]) {
    const orig = SessionManager.prototype[m];
    SessionManager.prototype[m] = function (...a) { SM = this; return orig.apply(this, a); };
  }
}

function state(sup, gc) {
  const r = {};
  try {
    const s = sup.snapshotSupervisor();
    r.ptys = s.ptys.map((p) => ({ key: p.sessionKey, pid: p.pid, sessionId: p.sessionId, alive: p.isAlive }));
    r.quarantined = s.quarantined;
    r.groupUnconfirmedObserved = s.groupUnconfirmedObserved;
  } catch (err) { r.error = String(err); }
  try { r.counter = gc.groupUnconfirmedObservedCount(); } catch (err) { r.counterError = String(err); }
  try { r.bus = SM ? SM.health() : null; } catch (err) { r.busError = String(err); }
  try {
    if (SM) { const a = SM.getAgent("default"); r.busPid = a?.pid ?? null; r.busSession = a?.session_id ?? a?.sessionId ?? null; }
  } catch (err) { r.busError = String(err); }
  return r;
}

async function turn(runner, prompt) {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  try {
    const r = await runner.runUserMessage("soak-chat", prompt);
    return { startedAt, endedAt: new Date().toISOString(), ms: Date.now() - t0, exitCode: r.exitCode, failureKind: r.failureKind ?? null,
      stdout: (r.stdout || "").slice(-4000), stderr: (r.stderr || "").slice(0, 1500), sessionId: r.sessionId };
  } catch (err) {
    return { startedAt, endedAt: new Date().toISOString(), ms: Date.now() - t0, exitCode: -1, error: String(err) };
  }
}

async function timed(fn) {
  const t0 = Date.now();
  try { await fn(); return { ok: true, ms: Date.now() - t0 }; } catch (err) { return { ok: false, ms: Date.now() - t0, error: String(err) }; }
}

async function handle(m, file) {
  const mm = file.match(/^(.*)\.(\w+)$/);
  const [id, kind] = [mm[1], mm[2]];
  const work = `${TRIGGER}/${file}.taken`;
  await rename(`${TRIGGER}/${file}`, work);
  const raw = (await readFile(work, "utf-8")).trim();
  const body = raw ? JSON.parse(raw) : {};
  const res = { id, kind, startedAt: new Date().toISOString() };
  if (kind === "chat") res.chat = await turn(m.runner, body.prompt);
  else if (kind === "fake") {
    const now = new Date().toISOString();
    const nonce = (body.prompt.match(/N-[0-9a-f]{8}/) || [""])[0];
    res.chat = { startedAt: now, endedAt: now, ms: 0, exitCode: 0, failureKind: null, stdout: nonce, stderr: "", sessionId: body.sessionId, fake: true };
  } else if (kind === "state") res.state = state(m.sup, m.gc);
  else if (kind === "killturn") {
    res.before = state(m.sup, m.gc);
    const p = turn(m.runner, body.prompt);
    await new Promise((r) => setTimeout(r, body.delayMs));
    res.killAt = new Date().toISOString();
    const kr = m.runner.killActiveReport(); res.killed = kr.killed;
    const chat = await p;
    try { res.killOutcome = await kr.settled; } catch (err) { res.killOutcomeError = String(err); }
    res.chat = chat;
    res.after = state(m.sup, m.gc);
  } else if (kind === "retire") {
    res.before = state(m.sup, m.gc);
    res.retire = await timed(() => m.sup.retirePtySession(body.key || "global"));
    res.after = state(m.sup, m.gc);
  } else if (kind === "busclear" || kind === "busretire") {
    res.before = state(m.sup, m.gc);
    if (!SM) res.retire = { ok: false, error: "no SessionManager captured yet" };
    else res.retire = await timed(() => (kind === "busclear" ? SM.clearSession(body.agent || "default") : SM.restart(body.agent || "default", { reason: "soak-retire" })));
    res.after = state(m.sup, m.gc);
  } else if (kind === "oneshot") {
    const t0 = Date.now();
    try {
      const r = await m.oneshot.runOneShot({ route: body.route, prompt: body.prompt, isolation: "untrusted", timeoutMs: body.timeoutMs || 180000 });
      res.oneshot = { ms: Date.now() - t0, engine: r.engine, model: r.model, exitCode: r.exitCode, text: (r.text || "").slice(0, 400), diagnostic: r.diagnostic ? String(JSON.stringify(r.diagnostic)).slice(0, 400) : null };
    } catch (err) { res.oneshot = { ms: Date.now() - t0, exitCode: -1, error: String(err).slice(0, 400) }; }
  } else res.error = "unknown kind";
  res.endedAt = new Date().toISOString();
  await writeFile(`${OUT}/.${id}.tmp`, JSON.stringify(res, null, 2));
  await rename(`${OUT}/.${id}.tmp`, `${OUT}/${id}.json`);
}

export default function init(api) {
  configure(api.pluginConfig || {});
  let timer = null;
  let busy = false;
  api.registerService({
    id: "soak-trigger",
    async start() {
      await mkdir(TRIGGER, { recursive: true });
      await mkdir(OUT, { recursive: true });
      const m = {
        runner: await import(`${R}/runner.ts`),
        sup: await import(`${R}/runner/pty-supervisor.ts`),
        gc: await import(`${R}/runner/pty-group-confirm.ts`),
        oneshot: await import(`${R}/oneshot/engine.ts`),
      };
      capture((await import(`${R}/bus/session-manager.ts`)).SessionManager);
      timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          for (const f of (await readdir(TRIGGER)).sort()) {
            if (/^[^.].*\.(chat|fake|state|killturn|retire|busclear|busretire|oneshot)$/.test(f)) await handle(m, f);
          }
        } catch (err) {
          api.logger.error("[soak-trigger]", String(err));
        } finally {
          busy = false;
        }
      }, 1000);
      api.logger.info("[soak-trigger] watching", TRIGGER);
    },
    async stop() { if (timer) clearInterval(timer); },
  });
}
