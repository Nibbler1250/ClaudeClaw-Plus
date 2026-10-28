#!/usr/bin/env python3
"""Soak pilot for an ISOLATED ClaudeClaw-Plus daemon. Standard library only; run with `python3 -I`. No LLM of its own.

The isolated daemon (HOME/XDG/socket/TMPDIR under SOAK_BASE, web on 127.0.0.1:SOAK_PORT) runs in systemd --user
transient units <SOAK_UNIT_PREFIX>-<n> (KillMode=process: a claude the daemon leaves behind on stop stays visible
and counts as an orphan). A live daemon unit (SOAK_LIVE_UNIT) is only read (MainPID). The live credentials file is
only read. Every kill targets a PID whose /proc/<pid>/environ carries HOME=<isolated home>.

  pilot.py short [--plan x,y,...] [--e-idle-seconds N]   proof cycle (fake completions + 1 of each scenario)
  pilot.py soak  [--hours 8] [--e-idle-seconds N]        soak; stops when the counts are reached (ceiling --hours)
  pilot.py summary <run-dir>                             recompute summary.json + counts.md
  pilot.py start-instance | stop-instance | credsync | write-jobs

Every turn = "Reply with exactly: N-<8 hex>". False completion = a turn reported done (exit 0) with no assistant
JSONL entry carrying ITS nonce in the session transcript at the time it returned (rechecked at +120 s).

Scenarios: a /kill during a turn · b restart of the isolated daemon · c /clear on the bus agent + nonce
· d /compact on the bus agent + nonce · e SIGKILL the claude of an idle agent (runner or bus)
· f retire an agent whose MCP servers include a slow-exit one and a SIGTERM-ignoring one.

Linux only: process discovery reads /proc (see README for the list of functions to port elsewhere).
"""
import csv
import json
import os
import queue
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ───────────────────────── configuration (same defaults as env.sh) ─────────────────────────

HERE = Path(__file__).resolve().parent


def _env(key, default):
    v = os.environ.get(key)
    return v if v else str(default)


BASE = Path(_env("SOAK_BASE", Path.home() / ".local" / "state" / "ccplus-soak"))
ISO_HOME = _env("SOAK_HOME", BASE / "home")
WS = Path(_env("SOAK_WS", BASE / "ws"))
TMP = Path(_env("SOAK_TMP", BASE / "tmp"))
RUNTIME = Path(_env("SOAK_RUN", BASE / "run"))
RESULTS = Path(_env("SOAK_RESULTS", BASE / "results"))
PORT = int(_env("SOAK_PORT", 18562))
REPO = Path(_env("SOAK_REPO", HERE.parent))
UNIT_PREFIX = _env("SOAK_UNIT_PREFIX", "ccplus-soak-instance")
LIVE_UNIT = os.environ.get("SOAK_LIVE_UNIT", "claudeclaw.service")  # empty string = do not watch a live daemon
LIVE_CREDS = Path(_env("SOAK_LIVE_CREDENTIALS", Path.home() / ".claude" / ".credentials.json"))
BUN = os.environ.get("BUN") or "bun"

INSTANCE_SH = HERE / "instance.sh"
INSTANCE_LOG = RESULTS / "instance.log"
PROJECTS = Path(ISO_HOME) / ".claude" / "projects"
CC = WS / ".claude" / "claudeclaw"
SETTINGS = CC / "settings.json"
JOBS = CC / "jobs"
TRIGGER = BASE / "trigger"
PLUGIN_OUT = RESULTS / "plugin"
STATE_FILE = BASE / "state.json"
ISO_CREDS = Path(ISO_HOME) / ".claude" / ".credentials.json"
MCP_DIR = str(REPO / "soak" / "mcp")
MCP_KINDS = ("mcp-ok", "mcp-lent", "mcp-sourd")

NONCE = re.compile(r"N-[0-9a-f]{8}")
CRON_JOBS = {  # name: (schedule, model, timeout s, prompt template)
    "soak-hourly": ("*/6 * * * *", "haiku", 300, "Reply with exactly: {n}"),
    "soak-daily": ("3-59/6 * * * *", "haiku", 300, "Reply with exactly: {n}"),
}
ONESHOT_ROUTES = ["tuner.judge", "tuner.propose", "memory.recall", "discord.classifier"]
TARGETS = {"trusted": 150, "oneshot": 100, "scenario": 10}
E_IDLE_S = 60  # scenario e idle window (--e-idle-seconds)
DISK_MIN_FREE = 10e9
_TOKEN = None


def token():
    global _TOKEN
    if _TOKEN is None:
        _TOKEN = json.loads(SETTINGS.read_text())["apiToken"]
    return _TOKEN


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def iso_ms(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def nonce():
    return "N-" + secrets.token_hex(4)


def sh(*args, timeout=60):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


class Run:
    def __init__(self, out: Path):
        self.out = out
        out.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.ev = open(out / "events.jsonl", "a", buffering=1)
        new = not (out / "ps.csv").exists()
        self.psf = open(out / "ps.csv", "a", buffering=1, newline="")
        self.ps = csv.writer(self.psf)
        if new:
            self.ps.writerow(["ts", "claude", "print", "print_unexpected", "bus_agent", "global", "cron", "other",
                              "dup_sessions", "orphans", "live_daemon_pid", "instance_main_pid"])

    def event(self, kind, **kw):
        rec = {"ts": now_iso(), "kind": kind, **kw}
        with self.lock:
            self.ev.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return rec


# ───────────────────────── instance control ─────────────────────────

def load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {"n": 0}


def save_state(st):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(st))


def current_unit():
    return f"{UNIT_PREFIX}-{load_state()['n']}"


def unit_prop(unit, prop):
    return sh("systemctl", "--user", "show", "-p", prop, "--value", unit)


def main_pid():
    p = unit_prop(current_unit(), "MainPID")
    return int(p) if p and p.isdigit() and p != "0" else None


def engines_count():
    return INSTANCE_LOG.read_text(errors="replace").count("Engines:") if INSTANCE_LOG.exists() else 0


def http(method, path, body=None, timeout=900):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw, code = r.read().decode(errors="replace"), r.status
    except urllib.error.HTTPError as e:
        raw, code = e.read().decode(errors="replace"), e.code
    except Exception as e:  # noqa: BLE001
        return {"http": None, "error": f"{type(e).__name__}: {e}", "ms": int((time.time() - t0) * 1000)}
    try:
        js = json.loads(raw)
    except ValueError:
        js = {"raw": raw[:300]}
    return {"http": code, "ms": int((time.time() - t0) * 1000), **(js if isinstance(js, dict) else {"raw": str(js)[:300]})}


def start_instance():
    st = load_state()
    st["n"] += 1
    save_state(st)
    before = engines_count()
    bun = shutil.which(BUN) or BUN
    env = {"SOAK_BASE": BASE, "SOAK_HOME": ISO_HOME, "SOAK_WS": WS, "SOAK_TMP": TMP, "SOAK_RUN": RUNTIME,
           "SOAK_RESULTS": RESULTS, "SOAK_PORT": PORT, "SOAK_REPO": REPO, "BUN": bun}
    setenv = [f"--setenv={k}={v}" for k, v in env.items()]
    sh("systemd-run", "--user", "--collect", f"--unit={UNIT_PREFIX}-{st['n']}", "-p", "KillMode=process",
       "-p", "TimeoutStopSec=90", *setenv, str(INSTANCE_SH), timeout=60)
    for _ in range(120):
        time.sleep(2)
        if engines_count() > before and http("GET", "/api/health", timeout=5).get("http") == 200:
            return True
    return False


def stop_instance():
    unit = current_unit()
    pid = main_pid()
    sh("systemctl", "--user", "stop", unit, timeout=150)
    for _ in range(100):
        if not pid or not Path(f"/proc/{pid}").exists():
            return True
        time.sleep(1)
    return False


# ───────────────────────── process sampling (/proc) ─────────────────────────

def isolated_procs():
    """Every process (own uid) whose environ has HOME=<isolated>, with claude info."""
    out = {}
    for d in Path("/proc").iterdir():
        if not d.name.isdigit():
            continue
        try:
            env = (d / "environ").read_bytes()
            if f"HOME={ISO_HOME}".encode() + b"\0" not in env + b"\0":
                continue
            argv = [a.decode(errors="replace") for a in (d / "cmdline").read_bytes().split(b"\0") if a]
            exe = os.readlink(d / "exe")
            stat = (d / "stat").read_text()
            ppid = int(stat.rsplit(")", 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            continue
        pid = int(d.name)
        is_claude = "claude/versions" in exe or (argv and os.path.basename(argv[0]) == "claude")
        info = {"pid": pid, "ppid": ppid, "claude": is_claude}
        if is_claude:
            def val(*flags):
                for f in flags:
                    if f in argv:
                        i = argv.index(f)
                        return argv[i + 1] if i + 1 < len(argv) else ""
                return None
            info.update(print="-p" in argv or "--print" in argv, session=val("--session-id", "--resume", "-r"),
                        bus="--dangerously-load-development-channels" in argv, model=val("--model"))
        out[pid] = info
    return out


def ancestors(pid, procs):
    seen = []
    while pid in procs and pid not in seen:
        seen.append(pid)
        pid = procs[pid]["ppid"]
    seen.append(pid)
    return seen


def session_ids():
    g, threads = None, {}
    try:
        g = json.loads((CC / "session.json").read_text()).get("sessionId")
    except (OSError, ValueError):
        pass
    try:
        threads = {k: v.get("sessionId") for k, v in json.loads((CC / "sessions.json").read_text()).get("threads", {}).items()}
    except (OSError, ValueError):
        pass
    return g, threads


class Sampler:
    def __init__(self, run: Run):
        self.run = run
        self.seen = {}
        self.last_row = 0.0
        self.live_pid = None
        self.print_ok = False  # True inside a window where `claude -p` is expected (none in the current plan)
        self.lock = threading.Lock()
        self.orphan_first = {}
        self.max_per_session = {}  # session -> max simultaneous claude procs

    def tick(self):
        with self.lock:
            return self._tick()

    def _tick(self):
        procs = isolated_procs()
        mp = main_pid()
        g, threads = session_ids()
        cron_sids = set(threads.values())
        claude = {p: i for p, i in procs.items() if i["claude"]}
        for pid, i in claude.items():
            i["class"] = "bus" if i["bus"] else "global" if i["session"] == g else "cron" if i["session"] in cron_sids else "other"
            if pid not in self.seen:
                i["first_seen"] = time.time()
                self.seen[pid] = i
                self.run.event("proc_seen", pid=pid, cls=i["class"], print=i["print"], session=i["session"], model=i["model"])
                if i["print"]:
                    self.run.event("PRINT_PROCESS", pid=pid, cls=i["class"], expected=self.print_ok, session=i["session"])
        for pid in list(self.seen):
            if pid not in claude:
                i = self.seen.pop(pid)
                self.run.event("proc_gone", pid=pid, cls=i["class"], lifetime_s=round(time.time() - i["first_seen"], 1))
        by_sess = {}
        for i in claude.values():
            if i.get("session"):
                by_sess.setdefault(i["session"], []).append(i["pid"])
        for s, p in by_sess.items():
            self.max_per_session[s] = max(self.max_per_session.get(s, 0), len(p))
        dups = {s: p for s, p in by_sess.items() if len(p) > 1}
        if dups:
            self.run.event("DUP_WRITER", sessions=dups, print_window=self.print_ok)
        # orphan = isolated claude not descending from the current instance main pid, seen twice >= 10 s apart
        orphans = []
        for pid in claude:
            if mp is None or mp not in ancestors(pid, procs):
                t = self.orphan_first.setdefault(pid, time.time())
                if time.time() - t >= 10:
                    orphans.append(pid)
            else:
                self.orphan_first.pop(pid, None)
        for pid in list(self.orphan_first):
            if pid not in claude:
                self.orphan_first.pop(pid)
        if time.time() - self.last_row >= 60:
            self.last_row = time.time()
            live = unit_prop(LIVE_UNIT, "MainPID") if LIVE_UNIT else ""
            if self.live_pid is None:
                self.live_pid = live
            elif live != self.live_pid:
                self.run.event("live_daemon_pid_changed", before=self.live_pid, after=live)
                self.live_pid = live
            cl = list(claude.values())
            self.run.ps.writerow([now_iso(), len(cl), sum(i["print"] for i in cl),
                                  sum(i["print"] for i in cl) if not self.print_ok else 0,
                                  sum(i["class"] == "bus" for i in cl), sum(i["class"] == "global" for i in cl),
                                  sum(i["class"] == "cron" for i in cl), sum(i["class"] == "other" for i in cl),
                                  len(dups), len(orphans), live, mp])
            if orphans:
                self.run.event("ORPHAN_SEEN", pids=orphans, main_pid=mp)
        return claude, procs


class FastSample:
    """Sample every 0.5 s during a scenario; record max simultaneous procs per session + print procs."""

    def __init__(self, sampler):
        self.sampler, self.stop_flag, self.max, self.prints, self.global_pids = sampler, False, {}, set(), set()
        self.t = threading.Thread(target=self._loop, daemon=True)

    def _loop(self):
        while not self.stop_flag:
            try:
                claude, _ = self.sampler.tick()
            except Exception:  # noqa: BLE001
                claude = {}
            by = {}
            for i in claude.values():
                if i.get("session"):
                    by.setdefault(i["session"], set()).add(i["pid"])
                if i["print"]:
                    self.prints.add((i["pid"], i["class"]))
                if i["class"] == "global":
                    self.global_pids.add((i["pid"], i["print"]))
            for s, p in by.items():
                self.max[s] = max(self.max.get(s, 0), len(p))
            time.sleep(0.5)

    def __enter__(self):
        self.t.start()
        return self

    def __exit__(self, *a):
        self.stop_flag = True
        self.t.join(5)


def mcp_procs():
    """Every fake MCP server of this harness: {pid: {kind, ppid}} (process comm + executable path under MCP_DIR)."""
    out = {}
    for d in Path("/proc").iterdir():
        if not d.name.isdigit():
            continue
        try:
            argv = (d / "cmdline").read_bytes().split(b"\0")
            comm = (d / "comm").read_text().strip()
            stat = (d / "stat").read_text()
        except OSError:
            continue
        if comm in MCP_KINDS and any(a.decode(errors="replace").startswith(MCP_DIR) for a in argv):
            out[int(d.name)] = {"kind": comm, "ppid": int(stat.rsplit(")", 1)[1].split()[1])}
    return out


def all_ppids():
    m = {}
    for d in Path("/proc").iterdir():
        if d.name.isdigit():
            try:
                m[int(d.name)] = int((d / "stat").read_text().rsplit(")", 1)[1].split()[1])
            except (OSError, ValueError, IndexError):
                pass
    return m


def chain(pid, pp):
    seen = []
    while pid in pp and pid not in seen and pid > 1:
        seen.append(pid)
        pid = pp[pid]
    return seen


def orphan_snapshot():
    """Isolated claude + fake MCP processes not descending from the instance main pid."""
    mp = main_pid()
    pp = all_ppids()
    procs = isolated_procs()
    claude = [p for p, i in procs.items() if i["claude"] and (mp is None or mp not in chain(p, pp))]
    mcp = [{"pid": p, "kind": i["kind"]} for p, i in mcp_procs().items() if mp is None or mp not in chain(p, pp)]
    return {"claude": claude, "mcp": mcp}


def mcp_under(pid):
    pp = all_ppids()
    return {p: i["kind"] for p, i in mcp_procs().items() if pid in chain(p, pp)}


def is_isolated(pid):
    try:
        return f"HOME={ISO_HOME}".encode() + b"\0" in Path(f"/proc/{pid}/environ").read_bytes() + b"\0"
    except OSError:
        return False


def bus_claude():
    return [p for p, i in isolated_procs().items() if i["claude"] and i.get("bus")]


def oneshot_dirs():
    return sorted(x.name for x in TMP.glob("claudeclaw-oneshot-*"))


def watch_gone(pids, limit):
    """Poll every 0.2 s; return {pid: seconds until gone or None}."""
    t0, res = time.time(), {p: None for p in pids}
    while time.time() - t0 < limit and any(v is None for v in res.values()):
        for p in res:
            if res[p] is None and not Path(f"/proc/{p}").exists():
                res[p] = round(time.time() - t0, 2)
        time.sleep(0.2)
    return res


def kill_isolated(pids):
    """SIGTERM then (after 5 s) SIGKILL, only for PIDs whose environ carries HOME=<isolated home>."""
    done = []
    for p in pids:
        try:
            env = Path(f"/proc/{p}/environ").read_bytes()
        except OSError:
            continue
        if f"HOME={ISO_HOME}".encode() + b"\0" in env + b"\0" and p != os.getpid():
            try:
                os.kill(p, signal.SIGTERM)
                done.append(p)
            except OSError:
                pass
    time.sleep(5)
    for p in done:
        if Path(f"/proc/{p}").exists():
            try:
                os.kill(p, signal.SIGKILL)
            except OSError:
                pass
    return done


# ───────────────────────── log tailer ─────────────────────────

LOG_PATTERNS = [
    ("group_unconfirmed", re.compile(r"\[pty\] group-unconfirmed")),
    ("quarantine", re.compile(r"quarantine", re.I)),
    ("group_kill", re.compile(r"\[pty-group-kill\]")),
    ("kill_unconfirmed", re.compile(r"still unconfirmed")),
    ("running", re.compile(r"Running: (\S+)")),
    ("done", re.compile(r"Done: (\S+) → (\S+)")),
    ("not_retried", re.compile(r"not retried")),
    ("retry", re.compile(r"retrying in|exhausted \d+ retries")),
    ("in_use", re.compile(r"already in use", re.I)),
    ("pty", re.compile(r"\[pty-supervisor\]")),
    ("engines", re.compile(r"Engines:")),
    ("error", re.compile(r"\berror\b|exited outside stop", re.I)),
]


class LogTail:
    def __init__(self, run: Run, on_done):
        self.run, self.on_done = run, on_done
        self.pos = INSTANCE_LOG.stat().st_size if INSTANCE_LOG.exists() else 0
        self.buf = ""

    def tick(self):
        if not INSTANCE_LOG.exists():
            return
        with open(INSTANCE_LOG, errors="replace") as f:
            f.seek(self.pos)
            data = f.read()
            self.pos = f.tell()
        self.buf += data
        lines = self.buf.split("\n")
        self.buf = lines.pop()
        for line in lines:
            if re.match(r"^\s*\d+ \|", line):
                continue
            for cat, rx in LOG_PATTERNS:
                m = rx.search(line)
                if m:
                    self.run.event("log", cat=cat, line=line.strip()[:300])
                    if cat == "done" and m.group(1) in CRON_JOBS:
                        self.on_done(m.group(1), m.group(2))
                    break


# ───────────────────────── transcript verification ─────────────────────────

def jsonl_lines(path):
    try:
        with open(path, errors="replace") as f:
            for line in f:
                try:
                    yield json.loads(line)
                except ValueError:
                    continue
    except OSError:
        return


def text_of(d, with_tools=False):
    c = (d.get("message") or {}).get("content")
    if isinstance(c, str):
        return c
    out = []
    for x in c or []:
        if isinstance(x, dict):
            if x.get("type") == "text":
                out.append(x.get("text", ""))
            elif with_tools and x.get("type") == "tool_use":
                out.append(json.dumps(x.get("input", {}), ensure_ascii=False))
    return "\n".join(out)


def session_file(sid):
    if not sid:
        return None
    for f in PROJECTS.glob(f"*/{sid}.jsonl"):
        return f
    return None


def turn_facts(sid, n, since_ts, with_tools=False):
    """Facts about the turn carrying nonce `n` in session `sid` (falls back to every recent JSONL)."""
    files = [session_file(sid)] if session_file(sid) else []
    if not files:
        files = [f for f in PROJECTS.rglob("*.jsonl") if f.stat().st_mtime >= since_ts - 5]
    r = {"file": None, "prompts": 0, "answers": 0, "answer_ts": None, "turn_duration": False,
         "assistant_entries": 0, "missing_message_id": 0, "final_blocks": 0, "final_texts": [], "elsewhere": False}
    for f in files:
        in_turn, final_id, ids_lines = False, None, {}
        for d in jsonl_lines(f):
            t = d.get("type")
            if t == "user" and not d.get("isMeta"):
                body = text_of(d)
                if n in body and "tool_result" not in json.dumps((d.get("message") or {}).get("content", ""))[:200]:
                    r["prompts"] += 1
                    r["file"] = f.name
                    in_turn = True
                    continue
                if in_turn and body and not d.get("toolUseResult") and "tool_result" not in json.dumps((d.get("message") or {}).get("content", ""))[:200]:
                    in_turn = False  # next real prompt ends the turn
            if not in_turn:
                continue
            if t == "assistant":
                r["assistant_entries"] += 1
                mid = (d.get("message") or {}).get("id")
                if not mid:
                    r["missing_message_id"] += 1
                ids_lines.setdefault(mid, []).append(d)
                if n in text_of(d, with_tools):
                    r["answers"] += 1
                    final_id = mid
                    if not r["answer_ts"]:
                        r["answer_ts"] = d.get("timestamp")
            elif t == "system" and d.get("subtype") == "turn_duration":
                r["turn_duration"] = True
                in_turn = False
        if final_id is not None:
            lines = ids_lines.get(final_id, [])
            r["final_blocks"] = len(lines)
            r["final_texts"] = [text_of(x) for x in lines if text_of(x)]
    if r["answers"] == 0 and files and sid:
        # answer written to another session file? (wrong-session write)
        for f in PROJECTS.rglob("*.jsonl"):
            if f.stat().st_mtime >= since_ts - 5 and f.name != f"{sid}.jsonl":
                if any(d.get("type") == "assistant" and n in text_of(d, with_tools) for d in jsonl_lines(f)):
                    r["elsewhere"] = True
                    break
    return r


def judge(exit_code, facts):
    """Verdict on a turn the daemon reported. Criterion: reported done (exit 0) => nonce answer present now."""
    if exit_code == 0:
        return "ok" if facts["answers"] >= 1 else "FALSE_COMPLETION"
    return "reported_fail"


# ───────────────────────── credentials / jobs ─────────────────────────

def cred_sync(run=None):
    """Copy the ACCESS token only (never the refresh token) from the live credentials into the isolated copy.
    The live file is only read. Creates the isolated file (0600) if it does not exist yet."""
    try:
        live = json.loads(LIVE_CREDS.read_text())["claudeAiOauth"]
    except (OSError, ValueError, KeyError) as e:
        if run:
            run.event("cred_sync", ok=False, error=repr(e))
        return False
    try:
        iso = json.loads(ISO_CREDS.read_text())
    except OSError:
        iso = {}
    except ValueError as e:
        if run:
            run.event("cred_sync", ok=False, error=repr(e))
        return False
    o = iso.setdefault("claudeAiOauth", {})
    if live.get("expiresAt", 0) > o.get("expiresAt", 0):
        for k in ("accessToken", "expiresAt", "scopes", "subscriptionType", "rateLimitTier"):
            if k in live:
                o[k] = live[k]
        o["refreshToken"] = ""
        ISO_CREDS.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = ISO_CREDS.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.write(fd, json.dumps(iso).encode())
        os.close(fd)
        os.rename(tmp, ISO_CREDS)
        if run:
            run.event("cred_sync", ok=True, iso_expires=datetime.fromtimestamp(o["expiresAt"] / 1000, timezone.utc).isoformat())
    return True


def write_job(job):
    sched, model, timeout, tpl = CRON_JOBS[job]
    JOBS.mkdir(parents=True, exist_ok=True)
    p = JOBS / f"{job}.md"
    tmp = JOBS / f".{job}.md.tmp"
    tmp.write_text(f"---\nschedule: \"{sched}\"\nrecurring: true\nmodel: {model}\ntimeout: {timeout}\nnotify: false\n---\n{tpl.format(n=nonce())}\n")
    tmp.rename(p)


# ───────────────────────── actions ─────────────────────────

class BaseActions:
    """Single worker queue, delayed checks, plugin trigger protocol, runner turns and cron verification."""

    def __init__(self, run: Run, sampler: Sampler):
        self.run, self.sampler = run, sampler
        self.q = queue.Queue()
        self.checks = []
        self.lock = threading.Lock()
        self.busy = False
        self.cron_seen = {}  # job -> last prompt nonce
        threading.Thread(target=self._worker, daemon=True).start()

    def _worker(self):
        while True:
            fn = self.q.get()
            self.busy = True
            try:
                fn()
            except Exception as e:  # noqa: BLE001
                self.run.event("PILOT_ERROR", where=getattr(fn, "__name__", "?"), error=repr(e))
            finally:
                self.busy = False

    def later(self, delay, fn):
        with self.lock:
            self.checks.append((time.time() + delay, fn))

    def run_due_checks(self):
        with self.lock:
            due = [c for c in self.checks if c[0] <= time.time()]
            self.checks = [c for c in self.checks if c[0] > time.time()]
        for _, fn in due:
            try:
                fn()
            except Exception as e:  # noqa: BLE001
                self.run.event("PILOT_ERROR", where="check", error=repr(e))

    def plugin(self, kind, body, wait=900):
        rid = f"{kind[0]}{int(time.time() * 1000)}"
        TRIGGER.mkdir(parents=True, exist_ok=True)
        tmp = TRIGGER / f".{rid}.tmp"
        tmp.write_text(json.dumps(body))
        tmp.rename(TRIGGER / f"{rid}.{kind}")
        out = PLUGIN_OUT / f"{rid}.json"
        end = time.time() + wait
        while time.time() < end:
            if out.exists():
                return json.loads(out.read_text())
            time.sleep(0.5)
        return None

    # runner turn (runUserMessage through the plugin)
    def runner_turn(self, path="runner", fake=False, tool=False):
        n = nonce()
        t0 = time.time()
        g, _ = session_ids()
        prompt = f"Use the Bash tool to run `echo ok`, then reply with exactly: {n}" if tool else f"Reply with exactly: {n}"
        res = self.plugin("fake" if fake else "chat", {"prompt": prompt, "sessionId": g})
        if res is None:
            return self.run.event("turn", path=path, nonce=n, verdict="NO_RESULT", note="plugin gave no result in 15 min")
        c = res["chat"]
        facts = turn_facts(c.get("sessionId"), n, t0)
        verdict = judge(c.get("exitCode"), facts)
        stdout = c.get("stdout") or ""
        whole = all(t.strip() in stdout for t in facts["final_texts"]) if facts["final_texts"] else None
        ev = self.run.event("turn", path=path, nonce=n, exitCode=c.get("exitCode"), failureKind=c.get("failureKind"),
                            ms=c.get("ms"), session=c.get("sessionId"), fake=bool(c.get("fake")),
                            stdout_has_nonce=n in stdout, in_use_text="already in use" in (stdout + (c.get("stderr") or "")).lower(),
                            stderr=(c.get("stderr") or "")[:300], **{k: v for k, v in facts.items() if k != "final_texts"},
                            multi_block=facts["final_blocks"] > 1, multi_block_whole=whole, verdict=verdict)

        def recheck():
            f2 = turn_facts(c.get("sessionId"), n, t0)
            self.run.event("turn_check", path=path, nonce=n, fake=bool(c.get("fake")), exitCode=c.get("exitCode"), answers=f2["answers"],
                           prompts=f2["prompts"], turn_duration=f2["turn_duration"], missing_message_id=f2["missing_message_id"],
                           elsewhere=f2["elsewhere"],
                           verdict="DUP_PROMPT" if f2["prompts"] > 1 else "ok" if (f2["answers"] or c.get("exitCode") != 0) else "MISSING")
        self.later(120, recheck)
        return ev

    # cron: called on each "Done:" line of a soak job
    def _cron_check(self, job, logfile):
        time.sleep(1)
        txt = Path(logfile).read_text(errors="replace") if Path(logfile).exists() else ""
        sid = (re.search(r"^Session: (\S+)", txt, re.M) or [None, None])[1]
        ec = re.search(r"^Exit code: (-?\d+)", txt, re.M)
        ec = int(ec.group(1)) if ec else None
        pm = re.search(r"^Prompt:.*?\n(.*?)\nExit code:", txt, re.S | re.M)
        n = (NONCE.search(pm.group(1)) if pm else None)
        n = n.group(0) if n else None
        stale = n is not None and self.cron_seen.get(job) == n
        self.cron_seen[job] = n
        t0 = os.path.getmtime(logfile) - 900 if Path(logfile).exists() else time.time() - 900
        facts = turn_facts(sid, n, t0) if n else {"answers": 0, "prompts": 0, "turn_duration": False, "missing_message_id": 0,
                                                  "final_blocks": 0, "assistant_entries": 0, "final_texts": [], "elsewhere": False, "file": None, "answer_ts": None}
        self.run.event("turn", path="cron", job=job, nonce=n, exitCode=ec, session=sid, logfile=Path(logfile).name, stale_prompt=stale,
                       **{k: v for k, v in facts.items() if k != "final_texts"}, multi_block=facts["final_blocks"] > 1,
                       verdict="STALE_PROMPT" if stale else ("NO_NONCE" if not n else judge(ec, facts)))
        write_job(job)  # fresh nonce for the next run (jobs reload every 30 s)

    def cred_sync(self):
        cred_sync(self.run)


def fake_cron(act):
    """Detector proof on the cron path: a fabricated job log claiming Exit 0 for a nonce that never ran."""
    n = nonce()
    _, threads = session_ids()
    sid = threads.get("soak-hourly", "00000000-0000-0000-0000-000000000000")
    f = act.run.out / f"fake-soak-hourly-{n}.log"
    f.write_text(f"# soak-hourly\nDate: {now_iso()}\nSession: {sid} (resumed)\nPrompt: [x]\nReply with exactly: {n}\nExit code: 0\n\n## Output\n● {n}\n")
    facts = turn_facts(sid, n, time.time() - 900)
    act.run.event("turn", path="fake-cron", fake=True, nonce=n, exitCode=0, session=sid,
                  **{k: v for k, v in facts.items() if k != "final_texts"}, verdict=judge(0, facts))


class Actions(BaseActions):
    def __init__(self, run, sampler):
        super().__init__(run, sampler)
        self.n = {"trusted": 0, "oneshot": 0, **{k: 0 for k in "abcdef"}}
        self.mcp_seen = 0

    def count_turn(self, ev):
        if not ev.get("fake") and ev.get("verdict") in ("ok", "FALSE_COMPLETION", "reported_fail"):
            self.n["trusted"] += 1
        return ev

    def runner_turn(self, path="runner", fake=False, tool=False):
        ev = super().runner_turn(path=path, fake=fake, tool=tool)
        if ev and ev.get("session") and not fake and self.mcp_seen < 3:
            self.mcp_seen += 1
            g = [p for p, i in isolated_procs().items() if i["claude"] and i.get("session") == ev["session"]]
            self.run.event("mcp_check", path=path, claude=g, mcp={str(p): mcp_under(p) for p in g})
        return self.count_turn(ev)

    def bus_turn(self, path="bus", fake=False):
        n = nonce()
        t0 = time.time()
        if fake:  # detector proof: a reply claiming success for a nonce that was never sent
            r = {"http": 200, "ok": True, "exitCode": 0, "result": n, "ms": 0}
        else:
            r = http("POST", "/api/inject", {"message": f"Reply with exactly: {n}"}, timeout=400)
        ok_rep = bool(r.get("ok")) and r.get("exitCode", 0) == 0
        f = turn_facts(None, n, t0, with_tools=True)
        end = time.time() + 20  # the JSONL line can land a few hundred ms after the reply is delivered
        while ok_rep and not fake and f["answers"] == 0 and time.time() < end:
            time.sleep(1)
            f = turn_facts(None, n, t0, with_tools=True)
        ev = self.run.event("turn", path=path, nonce=n, fake=fake, http=r.get("http"), ok=r.get("ok"),
                            exitCode=0 if ok_rep else r.get("exitCode", -1), ms=r.get("ms"),
                            result_has_nonce=n in str(r.get("result", "")), error=r.get("error"), answers=f["answers"],
                            prompts=f["prompts"], file=f["file"], verdict=judge(0 if ok_rep else 1, f))

        def recheck():
            f2 = turn_facts(None, n, t0, with_tools=True)
            self.run.event("turn_check", path=path, nonce=n, fake=fake, exitCode=ev["exitCode"], answers=f2["answers"],
                           prompts=f2["prompts"], verdict="DUP_PROMPT" if f2["prompts"] > 1 else
                           "ok" if (f2["answers"] or ev["exitCode"] != 0) else "MISSING")
        if not fake:
            self.later(120, recheck)
        return self.count_turn(ev)

    def cron_done(self, job, logfile):  # own thread: never queued behind a long scenario (stale prompts)
        threading.Thread(target=self._cron_check, args=(job, logfile), daemon=True).start()

    def _cron_check(self, job, logfile):
        super()._cron_check(job, logfile)
        self.n["trusted"] += 1

    def oneshot(self, route=None, fake=False):
        route = route or ONESHOT_ROUTES[self.n["oneshot"] % len(ONESHOT_ROUTES)]
        n = nonce()
        if fake:
            res = {"oneshot": {"engine": "pty", "exitCode": 0, "text": "N-00000000", "ms": 0}}
        else:
            res = self.plugin("oneshot", {"route": route, "prompt": f"Reply with exactly: {n}", "timeoutMs": 180000}, wait=400) or {}
        o = res.get("oneshot") or {}
        ec = o.get("exitCode")
        verdict = ("NO_RESULT" if not o else "NOT_PTY" if o.get("engine") != "pty" else
                   ("ok" if n in (o.get("text") or "") else "FALSE_COMPLETION") if ec == 0 else "reported_fail")
        ev = self.run.event("oneshot", route=route, nonce=n, fake=fake, engine=o.get("engine"), model=o.get("model"),
                            exitCode=ec, ms=o.get("ms"), error=o.get("error"), diagnostic=o.get("diagnostic"), verdict=verdict)
        if not fake and verdict != "NO_RESULT":
            self.n["oneshot"] += 1
        return ev

    def state(self):
        res = self.plugin("state", {}, wait=120) or {}
        st = res.get("state") or {}
        self.run.event("sup_state", ptys=st.get("ptys"), quarantined=st.get("quarantined"), counter=st.get("counter"),
                       bus=st.get("bus"), bus_pid=st.get("busPid"), error=st.get("error") or st.get("busError"),
                       oneshot_dirs=len(oneshot_dirs()))
        return st

    def post_check(self, name, extra_delay=120):
        """Orphans now (+15 s after the scenario action) and again at +120 s."""
        o = orphan_snapshot()

        def later_check():
            self.run.event("orphan_recheck", scenario=name, **orphan_snapshot())
        self.later(extra_delay, later_check)
        return o

    def _scenario(self, name, ok, **kw):
        self.n[name] += 1
        return self.run.event("scenario", name=name, verdict="ok" if ok else "FAIL", **kw)

    # a. /kill during a turn
    def scenario_a(self, delay_ms):
        n = nonce()
        t0 = time.time()
        with FastSample(self.sampler):
            res = self.plugin("killturn", {"prompt": f"Use the Bash tool to run `for i in 1 2 3 4 5 6 7 8 9 10; do sleep 2; done`, then reply with exactly: {n}",
                                            "delayMs": delay_ms}, wait=400) or {}
            time.sleep(15)
        c = res.get("chat") or {}
        facts = turn_facts(c.get("sessionId"), n, t0)
        killed_turn = judge(c.get("exitCode"), facts)
        claude = isolated_procs()
        left = [p for p, i in claude.items() if i["claude"] and not i.get("bus")]
        busp = bus_claude()
        mcp_left = [{"pid": p, "kind": k} for p, k in ((p, i["kind"]) for p, i in mcp_procs().items())
                    if not any(b in chain(p, all_ppids()) for b in busp)]
        orph = self.post_check("a")
        ev2 = self.runner_turn(path="a-followup")
        ok = (killed_turn != "FALSE_COMPLETION" and not left and not mcp_left and not orph["claude"] and not orph["mcp"]
              and ev2["verdict"] == "ok")
        self._scenario("a", ok, delay_ms=delay_ms, killed=res.get("killed"), kill_outcome=res.get("killOutcome"),
                       killed_exit=c.get("exitCode"), killed_failureKind=c.get("failureKind"), killed_turn=killed_turn,
                       reported_killed=c.get("exitCode") != 0, nonce_ran_anyway=facts["answers"] > 0,
                       claude_left_15s=left, mcp_left_15s=mcp_left, orphans=orph, followup=ev2["verdict"],
                       quarantined_after=((res.get("after") or {}).get("quarantined")))

    # b. restart of the isolated daemon
    def scenario_b(self):
        self.runner_turn(path="b-pre")
        pre_mcp = mcp_procs()
        log_pos = INSTANCE_LOG.stat().st_size
        old_main = main_pid()
        stopped = stop_instance()
        time.sleep(15)
        procs = isolated_procs()
        orph_claude = [{"pid": p, "session": i.get("session"), "bus": i.get("bus")} for p, i in procs.items() if i["claude"]]
        orph_mcp = [{"pid": p, "kind": i["kind"]} for p, i in mcp_procs().items()]
        others = [p for p, i in procs.items() if not i["claude"] and p != os.getpid()]
        killed = kill_isolated([o["pid"] for o in orph_claude] + [o["pid"] for o in orph_mcp if is_isolated(o["pid"])] + others)
        up = start_instance()
        time.sleep(30)
        with open(INSTANCE_LOG, errors="replace") as f:
            f.seek(log_pos)
            new = f.read()
        ev = self.runner_turn(path="b-followup")
        evb = self.bus_turn(path="b-followup-bus")
        ok = stopped and up and not orph_claude and not orph_mcp and ev["verdict"] == "ok" and evb["verdict"] == "ok"
        self._scenario("b", ok, old_main=old_main, new_main=main_pid(), unit=current_unit(), stopped=stopped, up=up,
                       mcp_before=len(pre_mcp), orphans_claude_after_stop=orph_claude, orphans_mcp_after_stop=orph_mcp,
                       other_isolated_after_stop=len(others), killed_by_pilot=killed,
                       in_use_lines=len(re.findall(r"already in use", new, re.I)),
                       group_unconfirmed_lines=len(re.findall(r"\[pty\] group-unconfirmed", new)),
                       followup=ev["verdict"], followup_bus=evb["verdict"])

    def _bus_retire(self, kind, name):
        old = bus_claude()
        old_mcp = {p: k for b in old for p, k in mcp_under(b).items()}
        res = self.plugin(kind, {"agent": "default"}, wait=300) or {}
        gone = watch_gone(list(old) + list(old_mcp), 30)
        return old, old_mcp, res, gone

    # c. /clear on the bus agent, then a nonce
    def scenario_c(self):
        if not bus_claude():
            self.bus_turn(path="c-pre")
        old, old_mcp, res, gone = self._bus_retire("busclear", "c")
        orph = self.post_check("c")
        ev = self.bus_turn(path="c-followup")
        new = bus_claude()
        ok = (bool((res.get("retire") or {}).get("ok")) and all(v is not None for v in gone.values()) and not orph["claude"]
              and not orph["mcp"] and ev["verdict"] == "ok" and len(new) <= 1)
        self._scenario("c", ok, retire=res.get("retire"), old_claude=old, old_mcp=old_mcp, gone_s=gone, orphans=orph,
                       followup=ev["verdict"], bus_claude_after=new,
                       session_before=(res.get("before") or {}).get("busSession"), session_after=(res.get("after") or {}).get("busSession"))

    # d. /compact on the bus agent, then a nonce
    def scenario_d(self):
        if not bus_claude():
            self.bus_turn(path="d-pre")
        with FastSample(self.sampler) as fs:
            r = http("POST", "/api/inject", {"message": "/compact"}, timeout=400)
            ev = self.bus_turn(path="d-followup")
            maxbus = max((len([1 for i in self.sampler.seen.values() if i.get("bus")]),), default=0)
        orph = self.post_check("d")
        dups = [s for s, v in fs.max.items() if v > 1]
        ok = ev["verdict"] == "ok" and not dups and not orph["claude"] and not orph["mcp"] and len(bus_claude()) <= 1
        self._scenario("d", ok, compact_http=r.get("http"), compact_ok=r.get("ok"), compact_exit=r.get("exitCode"),
                       compact_ms=r.get("ms"), followup=ev["verdict"], dup_sessions=dups, bus_claude_seen=maxbus, orphans=orph)

    # e. SIGKILL the claude of an idle agent (crash): its MCP servers must still be retired
    def scenario_e(self, target):
        if target == "runner":
            st = self.state()
            g = [x for x in (st.get("ptys") or []) if x.get("key") == "global" and x.get("alive")]
            for _ in range(2):  # a first turn on a resumed session can be refused ("PTY prompt not accepted"): retry once
                if g:
                    break
                self.runner_turn(path="e-pre")
                time.sleep(3)
                g = [x for x in (self.state().get("ptys") or []) if x.get("key") == "global" and x.get("alive")]
            pid = g[0]["pid"] if g else None
        else:
            if not bus_claude():
                self.bus_turn(path="e-pre")
            b = bus_claude()
            pid = b[0] if b else None
        before_counter = self.state().get("counter")
        if not pid or not is_isolated(pid):
            return self._scenario("e", False, target=target, note="no idle isolated claude found", pid=pid)
        kids = mcp_under(pid)
        os.kill(pid, signal.SIGKILL)
        gone = watch_gone(list(kids), E_IDLE_S)  # agent idle: no new turn during this window
        idle_ok = bool(kids) and all(v is not None for v in gone.values())
        survivors = [p for p, v in gone.items() if v is None]
        respawn_by_pilot, gone_next = None, {}
        if target == "bus":
            t1 = time.time()
            while not [b for b in bus_claude() if b != pid] and time.time() - t1 < 30:
                time.sleep(1)
            if not [b for b in bus_claude() if b != pid]:
                # no auto-respawn after a crash (SessionManager forgets the agent: "cannot restart unknown agent"):
                # recover by restarting the isolated daemon, and check that restart leaves no orphan either
                ob = stop_instance()
                time.sleep(10)
                left = orphan_snapshot()
                respawn_by_pilot = {"daemon_restart": True, "stopped": ob, "orphans_after_stop": left, "up": start_instance()}
                time.sleep(20)
        after_counter = self.state().get("counter")
        ev = self.runner_turn(path="e-followup") if target == "runner" else self.bus_turn(path="e-followup-bus")
        if survivors:
            gone_next = watch_gone(survivors, 60)
        time.sleep(3)
        orph = self.post_check("e")
        all_gone = bool(kids) and all(v is not None for v in {**gone, **gone_next}.values())
        ok = all_gone and not orph["claude"] and not orph["mcp"] and ev["verdict"] == "ok"
        self._scenario("e", ok, target=target, pid=pid, mcp=kids, idle_window_s=E_IDLE_S, gone_idle_s=gone,
                       retired_while_idle=idle_ok, gone_after_next_turn_s=gone_next, respawn_by_pilot=respawn_by_pilot,
                       orphans=orph, counter_before=before_counter, counter_after=after_counter, followup=ev["verdict"])

    # f. retire an agent whose MCP servers include the slow-exit and SIGTERM-ignoring ones
    def scenario_f(self, target):
        if target == "runner":
            st = self.state()
            g = [x for x in (st.get("ptys") or []) if x.get("key") == "global" and x.get("alive")]
            for _ in range(2):  # a first turn on a resumed session can be refused ("PTY prompt not accepted"): retry once
                if g:
                    break
                self.runner_turn(path="f-pre")
                g = [x for x in (self.state().get("ptys") or []) if x.get("key") == "global" and x.get("alive")]
            pid = g[0]["pid"] if g else None
            kids = mcp_under(pid) if pid else {}
            res = self.plugin("retire", {"key": "global"}, wait=300) or {}
            gone = watch_gone(([pid] if pid else []) + list(kids), 30)
            old = [pid] if pid else []
        else:
            if not bus_claude():
                self.bus_turn(path="f-pre")
            old, kids, res, gone = self._bus_retire("busretire", "f")
        time.sleep(3)
        orph = self.post_check("f")
        ev = self.runner_turn(path="f-followup") if target == "runner" else self.bus_turn(path="f-followup-bus")
        kinds = set(kids.values())
        lent = [gone.get(p) for p, k in kids.items() if k == "mcp-lent"]
        ok = (bool((res.get("retire") or {}).get("ok")) and {"mcp-lent", "mcp-sourd"} <= kinds
              and all(v is not None for v in gone.values()) and not orph["claude"] and not orph["mcp"] and ev["verdict"] == "ok")
        self._scenario("f", ok, target=target, retire=res.get("retire"), old_claude=old, mcp=kids, gone_s=gone,
                       lent_exit_s=lent, orphans=orph, followup=ev["verdict"],
                       counter_after=(res.get("after") or {}).get("counter"))


# ───────────────────────── summary ─────────────────────────

def summarize(out: Path):
    ev = [json.loads(line) for line in open(out / "events.jsonl")]
    meta = json.loads((out / "meta.json").read_text()) if (out / "meta.json").exists() else {}
    turns = [e for e in ev if e["kind"] == "turn" and not e.get("fake")]
    fakes = [e for e in ev if e["kind"] in ("turn", "oneshot") and e.get("fake")]
    checks = [e for e in ev if e["kind"] == "turn_check" and not e.get("fake")]
    shots = [e for e in ev if e["kind"] == "oneshot" and not e.get("fake")]
    sc = [e for e in ev if e["kind"] == "scenario"]
    rows = list(csv.DictReader(open(out / "ps.csv"))) if (out / "ps.csv").exists() else []

    def count(items, key="verdict"):
        d = {}
        for e in items:
            d[str(e.get(key))] = d.get(str(e.get(key)), 0) + 1
        return d

    def family(p):
        return "cron" if p == "cron" else "bus" if p.startswith("bus") or p.endswith("-bus") or p in ("c-followup", "d-followup", "c-pre", "d-pre") else "runner"
    fam = {}
    for e in turns:
        fam.setdefault(family(e["path"]), []).append(e)
    fc = [e for e in turns + shots if e["verdict"] == "FALSE_COMPLETION"]
    prints = [e for e in ev if e["kind"] == "PRINT_PROCESS"]
    orphan_ev = [e for e in ev if e["kind"] == "ORPHAN_SEEN"]
    rechk = [e for e in ev if e["kind"] == "orphan_recheck"]
    final = next((e for e in ev if e["kind"] == "final_ps"), None)
    sweep = next((e for e in ev if e["kind"] == "sweep_check"), None)
    states = [e for e in ev if e["kind"] == "sup_state"]
    q_seen, q_last = {}, (states[-1].get("quarantined") or []) if states else []
    for e in states:
        for q in e.get("quarantined") or []:
            q_seen[json.dumps(q, sort_keys=True)] = e["ts"]
    gu = [e for e in ev if e["kind"] == "log" and e["cat"] == "group_unconfirmed"]
    reasons, comms = {}, {}
    for e in gu:
        m = re.search(r"reason=(\S+)", e["line"])
        c = re.search(r"comm=(\S+)", e["line"])
        if m:
            reasons[m.group(1)] = reasons.get(m.group(1), 0) + 1
        if c:
            for x in c.group(1).split(","):
                comms[x] = comms.get(x, 0) + 1
    counters = [e.get("counter") for e in states if isinstance(e.get("counter"), int)]
    sc_orph = sum(len((e.get("orphans") or {}).get("claude") or []) + len((e.get("orphans") or {}).get("mcp") or []) for e in sc) \
        + sum(len(e.get("orphans_claude_after_stop") or []) + len(e.get("orphans_mcp_after_stop") or []) for e in sc) \
        + sum(len(e.get("claude_left_15s") or []) + len(e.get("mcp_left_15s") or []) for e in sc)
    sc_orph += sum(len(((e.get("respawn_by_pilot") or {}).get("orphans_after_stop") or {}).get(k) or []) for e in sc if isinstance(e.get("respawn_by_pilot"), dict) for k in ("claude", "mcp"))
    rechk_orph = sum(len(e.get("claude") or []) + len(e.get("mcp") or []) for e in rechk)
    s = {
        "run": out.name, "meta": {k: meta.get(k) for k in ("mode", "start_utc", "repo_sha", "repo_branch", "plugin_version",
                                                           "claude_version", "os", "e_idle_seconds")},
        "first_event": ev[0]["ts"] if ev else None, "last_event": ev[-1]["ts"] if ev else None,
        "turns": {k: {"total": len(v), "verdicts": count(v)} for k, v in sorted(fam.items())},
        "turns_per_path": {p: len([e for e in turns if e["path"] == p]) for p in sorted({e["path"] for e in turns})},
        "oneshots": {"total": len(shots), "verdicts": count(shots), "per_route": count(shots, "route"), "engine": count(shots, "engine")},
        "false_completions": len(fc), "false_completion_list": [{"ts": e["ts"], "path": e.get("path") or e.get("route")} for e in fc],
        "rechecks_not_ok": count([e for e in checks if e["verdict"] != "ok"]),
        "claude_p": {"print_procs_seen": len(prints), "ps_rows_with_print": sum(1 for r in rows if int(r.get("print") or 0) > 0)},
        "orphans": {"after_scenarios": sc_orph, "at_120s_rechecks": rechk_orph, "during_run(ORPHAN_SEEN)": len(orphan_ev),
                    "final": (final or {}).get("orphans")},
        "quarantines": {"log_lines": len([e for e in ev if e["kind"] == "log" and e["cat"] == "quarantine"]),
                        "distinct_seen": len(q_seen), "still_quarantined_at_end": len(q_last)},
        "oneshot_tmp_dirs_after_sweep": (sweep or {}).get("left"),
        "group_unconfirmed": {"status_counter_last": counters[-1] if counters else None,
                              "status_counter_max": max(counters) if counters else None,
                              "log_lines": len(gu), "reasons": reasons, "comms": comms},
        "scenarios": {k: {"runs": sum(1 for e in sc if e["name"] == k), "verdicts": count([e for e in sc if e["name"] == k])} for k in "abcdef"},
        "e_retired_while_idle": {t: f"{sum(1 for e in sc if e['name'] == 'e' and e.get('target') == t and e.get('retired_while_idle'))}/{sum(1 for e in sc if e['name'] == 'e' and e.get('target') == t)}" for t in ("runner", "bus")},
        "e_bus_respawned_by_pilot": sum(1 for e in sc if e["name"] == "e" and e.get("respawn_by_pilot") is not None),
        "a_reported_killed": sum(1 for e in sc if e["name"] == "a" and e.get("reported_killed")),
        "f_lent_exit_s": [x for e in sc if e["name"] == "f" for x in (e.get("lent_exit_s") or [])],
        "detector_proof(fake)": {"injected": len(fakes), "flagged": sum(1 for e in fakes if e["verdict"] == "FALSE_COMPLETION")},
        "live_daemon_pid_changes": sum(1 for e in ev if e["kind"] == "live_daemon_pid_changed"),
        "pilot_errors": [e for e in ev if e["kind"] == "PILOT_ERROR"][:10],
    }
    bad = []
    if fc:
        bad.append(f"{len(fc)} false completion(s)")
    if prints:
        bad.append(f"{len(prints)} claude -p process(es)")
    if sc_orph or rechk_orph or (final and final.get("orphans")):
        bad.append("orphan claude/MCP process(es)")
    if q_last:
        bad.append("quarantine still present at end")
    if s["oneshot_tmp_dirs_after_sweep"]:
        bad.append("claudeclaw-oneshot-* dirs left after sweep")
    if any(e["verdict"] == "NOT_PTY" for e in shots):
        bad.append("one-shot not on PTY")
    for k, v in s["scenarios"].items():
        nb = {x: y for x, y in v["verdicts"].items() if x != "ok"}
        if nb:
            bad.append(f"scenario {k}: {nb}")
    s["failures"] = bad
    s["verdict"] = "PASS" if not bad else "FAIL"
    (out / "summary.json").write_text(json.dumps(s, indent=2, ensure_ascii=False))
    return s


def counts_md(s):
    """Counts and pass/fail only: no transcript, screen text or environment."""
    def pf(ok):
        return "PASS" if ok else "FAIL"
    m = s["meta"]
    t = s["turns"]
    o = s["oneshots"]
    g = s["group_unconfirmed"]
    idle = m.get("e_idle_seconds") or 60
    where = f"`{m['repo_branch']}` @ " if m.get("repo_branch") else ""
    L = [f"Soak on {where}`{(m.get('repo_sha') or '')[:8]}` ({m.get('plugin_version')}), claude {str(m.get('claude_version')).split()[0]}, "
         f"{m.get('os')}, isolated install. Window: {s['first_event']} → {s['last_event']}.",
         "Every agent (runner, cron, bus) had 3 stdio MCP servers: a normal one, one that waits ~5 s on SIGTERM, one that ignores SIGTERM (both also ignore SIGHUP and stdin EOF).", "",
         "**Turns** (`Reply exactly: N-<8 hex>`)", ""]
    L += [f"- {k}: {v['total']} ({', '.join(f'{a} {b}' for a, b in v['verdicts'].items())})" for k, v in t.items()]
    L += [f"- untrusted one-shots: {o['total']} ({', '.join(f'{a} {b}' for a, b in o['verdicts'].items())}); routes {', '.join(f'{a} {b}' for a, b in o['per_route'].items())}; engine {', '.join(f'{a} {b}' for a, b in o['engine'].items())}",
          "", "| Criterion | Count | Result |", "|---|---|---|",
          f"| False completions | {s['false_completions']} | {pf(s['false_completions'] == 0)} |",
          f"| Orphan claude / MCP after scenarios / at +120 s / final | {s['orphans']['after_scenarios']} / {s['orphans']['at_120s_rechecks']} / {s['orphans']['final']} | {pf(not s['orphans']['after_scenarios'] and not s['orphans']['at_120s_rechecks'] and not s['orphans']['final'])} |",
          f"| Quarantines (seen / still there at end) | {s['quarantines']['distinct_seen']} / {s['quarantines']['still_quarantined_at_end']} | {pf(not s['quarantines']['still_quarantined_at_end'])} |",
          f"| `claude -p` processes | {s['claude_p']['print_procs_seen']} | {pf(not s['claude_p']['print_procs_seen'])} |",
          f"| `claudeclaw-oneshot-*` dirs after sweep | {s['oneshot_tmp_dirs_after_sweep']} | {pf(not s['oneshot_tmp_dirs_after_sweep'])} |",
          f"| `/status` PTY groups unconfirmed (observed) | {g['status_counter_last']} | reported as is |",
          f"| Detector proof: fake completions injected / flagged | {s['detector_proof(fake)']['injected']} / {s['detector_proof(fake)']['flagged']} | {pf(s['detector_proof(fake)']['injected'] == s['detector_proof(fake)']['flagged']) if s['detector_proof(fake)']['injected'] else 'n/a (none injected)'} |", ""]
    if g["log_lines"]:
        L.append(f"group-unconfirmed log lines: {g['log_lines']}; reason= {g['reasons']}; comm= {g['comms']}")
        L.append("")
    names = {"a": "a. `/kill` during a turn", "b": "b. daemon restart", "c": "c. `/clear` on bus agent + nonce",
             "d": "d. `/compact` on bus agent + nonce", "e": "e. SIGKILL claude of an idle agent", "f": "f. retire agent with slow + SIGTERM-ignoring MCP"}
    L += ["**Scenarios**", ""]
    for k in "abcdef":
        v = s["scenarios"][k]
        L.append(f"- {names[k]}: {v['runs']} runs, {', '.join(f'{a} {b}' for a, b in v['verdicts'].items())} → {pf(set(v['verdicts']) <= {'ok'} and v['runs'] > 0)}")
    L.append(f"- e detail: MCP servers retired while the agent stayed idle (no new turn, {idle} s window): {s['e_retired_while_idle']}; "
             f"otherwise retired after the next turn on that agent. Bus agent not respawned by the daemon after the crash, harness restarted the isolated daemon to recover it: {s['e_bus_respawned_by_pilot']}")
    L += ["", f"**Overall: {s['verdict']}**"]
    L += [f"- {f}" for f in s["failures"]]
    return "\n".join(L) + "\n"


def write_summary(out: Path):
    s = summarize(out)
    (out / "counts.md").write_text(counts_md(s))
    return s


# ───────────────────────── main ─────────────────────────

def arg(name, default, cast=str):
    return cast(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


def refuse_real_home():
    real = str(Path.home().resolve())
    if not ISO_HOME or str(Path(ISO_HOME).resolve()) == real:
        sys.exit("refusing: SOAK_HOME must be an isolated directory, never your real home")


def main():
    global E_IDLE_S
    mode = sys.argv[1] if len(sys.argv) > 1 else "help"
    if mode == "summary":
        s = write_summary(Path(sys.argv[2]))
        print(json.dumps(s, indent=1, ensure_ascii=False))
        return
    if mode not in ("short", "soak", "credsync", "start-instance", "stop-instance", "write-jobs"):
        print(__doc__)
        sys.exit(0 if mode in ("help", "-h", "--help") else 2)
    refuse_real_home()
    if mode == "credsync":
        sys.exit(0 if cred_sync() else 1)
    if mode == "write-jobs":
        for j in CRON_JOBS:
            write_job(j)
        return
    if mode == "start-instance":
        cred_sync()
        print("up" if start_instance() else "FAILED", current_unit())
        return
    if mode == "stop-instance":
        print(stop_instance())
        return
    hours = arg("--hours", 8.0, float)
    E_IDLE_S = arg("--e-idle-seconds", 60, int)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out = RESULTS / f"{mode}-{stamp}"
    run = Run(out)
    start = time.time()
    deadline = start + (hours * 3600 if mode == "soak" else 3600)
    try:
        osr = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    except OSError:
        osr = {}
    try:
        plugin_version = json.loads((REPO / ".claude-plugin" / "plugin.json").read_text()).get("version")
    except (OSError, ValueError):
        plugin_version = None
    meta = {"mode": mode, "start_utc": now_iso(), "ceiling_utc": datetime.fromtimestamp(deadline, timezone.utc).isoformat(),
            "repo_sha": sh("git", "-C", str(REPO), "rev-parse", "HEAD"),
            "repo_branch": sh("git", "-C", str(REPO), "rev-parse", "--abbrev-ref", "HEAD"),
            "claude_version": sh(str(BASE / "bin" / "claude"), "--version"),
            "plugin_version": plugin_version,
            "os": f"Linux ({osr.get('PRETTY_NAME', '').strip(chr(34))}, kernel {os.uname().release})",
            "instance_unit": current_unit(), "pilot_pid": os.getpid(), "targets": TARGETS, "e_idle_seconds": E_IDLE_S}
    (out / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    run.event("start", **meta)
    (RESULTS / f"current-{mode}").unlink(missing_ok=True)
    (RESULTS / f"current-{mode}").symlink_to(out)
    stop = {"flag": False}
    signal.signal(signal.SIGTERM, lambda *_: stop.update(flag=True))
    signal.signal(signal.SIGINT, lambda *_: stop.update(flag=True))

    sampler = Sampler(run)
    act = Actions(run, sampler)
    tail = LogTail(run, act.cron_done)
    for j in CRON_JOBS:
        write_job(j)
    a_delays = [2000, 2500, 3000, 3500, 4000, 4500, 5000]
    ai = [0]
    ef = {"e": 0, "f": 0}

    def scen(k):
        if k == "a":
            d = a_delays[ai[0] % len(a_delays)]
            ai[0] += 1
            return lambda: act.scenario_a(d)
        if k in "ef":
            tgt = "runner" if ef[k] % 2 == 0 else "bus"
            ef[k] += 1
            return (lambda: act.scenario_e(tgt)) if k == "e" else (lambda: act.scenario_f(tgt))
        return {"b": act.scenario_b, "c": act.scenario_c, "d": act.scenario_d}[k]

    def block(i):
        k = "abcdef"[i % 6]
        return [scen(k), act.runner_turn, act.bus_turn, act.oneshot, act.oneshot]

    if mode == "short":
        names = arg("--plan", None)
        names = names.split(",") if names else \
            ["fake", "fake_bus", "fake_oneshot", "fake_cron", "r", "r", "bus", "bus", "r", "o", "o", "a", "b", "c", "d", "e", "e_bus", "f", "f_bus"]
        m = {"fake": lambda: act.runner_turn(path="fake-runner", fake=True), "fake_bus": lambda: act.bus_turn(path="fake-bus", fake=True),
             "fake_oneshot": lambda: act.oneshot(fake=True), "fake_cron": lambda: fake_cron(act), "r": act.runner_turn,
             "bus": act.bus_turn, "o": act.oneshot, "a": lambda: act.scenario_a(3000), "b": act.scenario_b, "c": act.scenario_c,
             "d": act.scenario_d, "e": lambda: act.scenario_e("runner"), "e_bus": lambda: act.scenario_e("bus"),
             "f": lambda: act.scenario_f("runner"), "f_bus": lambda: act.scenario_f("bus"), "state": act.state}
        for x in names:
            act.q.put(m[x])

    def done_counts():
        return (act.n["trusted"] >= TARGETS["trusted"] and act.n["oneshot"] >= TARGETS["oneshot"]
                and all(act.n[k] >= TARGETS["scenario"] for k in "abcdef"))

    bi = 0
    last_block = 0.0
    next_state = start + 20
    live_mtime = None
    while not stop["flag"] and time.time() < deadline:
        t = time.time()
        lt = time.localtime(t)
        try:
            mt = LIVE_CREDS.stat().st_mtime
            if mt != live_mtime:  # resync on mtime change; the live file is never written
                live_mtime = mt
                act.q.put(act.cred_sync)
        except OSError:
            pass
        if int(t) % 60 < 3 and shutil.disk_usage(BASE).free < DISK_MIN_FREE:
            run.event("DISK_LOW_STOP", free_gb=round(shutil.disk_usage(BASE).free / 1e9, 1))
            break
        if mode == "soak":
            if done_counts():
                run.event("counts_reached", **act.n)
                break
            if (not act.busy and act.q.empty() and t - last_block >= 300 and lt.tm_min % 3 == 1 and lt.tm_sec >= 15):
                last_block = t
                for fn in block(bi):
                    act.q.put(fn)
                bi += 1
        elif not act.busy and act.q.empty() and not act.checks:
            break
        if t >= next_state:
            next_state = t + 300
            act.q.put(act.state)
            run.event("counts", **act.n)
        act.run_due_checks()
        try:
            sampler.tick()
            tail.tick()
        except Exception as e:  # noqa: BLE001
            run.event("PILOT_ERROR", where="sample", error=repr(e))
        time.sleep(1 if mode == "short" else 3)
    # drain: wait for the worker and pending checks (max 10 min)
    end_wait = time.time() + 600
    while (act.busy or not act.q.empty() or act.checks) and time.time() < end_wait:
        act.run_due_checks()
        sampler.tick()
        tail.tick()
        time.sleep(3)
    # sweep: dirs older than 10 min are removed by the daemon's 10-min sweeper; wait up to 25 min (soak only)
    t_sw = time.time()
    while oneshot_dirs() and time.time() - t_sw < (1500 if mode == "soak" else 0):
        sampler.tick()
        tail.tick()
        time.sleep(10)
    run.event("sweep_check", left=len(oneshot_dirs()), names=oneshot_dirs()[:20], waited_s=round(time.time() - t_sw))
    act.state()
    tail.tick()
    if mode == "soak":
        stopped = stop_instance()
        time.sleep(15)
        procs = isolated_procs()
        orph = [p for p, i in procs.items() if i["claude"]] + [p for p in mcp_procs() if is_isolated(p)]
        others = [p for p, i in procs.items() if not i["claude"] and p != os.getpid() and p not in orph]
        run.event("final_ps", stopped=stopped, orphans=len(orph), orphan_pids=orph, other_isolated=len(others),
                  killed_by_pilot=kill_isolated(orph + others))
    run.event("end", reason="signal" if stop["flag"] else "counts" if mode == "soak" and done_counts() else "deadline/plan", counts=act.n)
    s = write_summary(out)
    print(json.dumps({"verdict": s["verdict"], "failures": s["failures"], "run": str(out)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
