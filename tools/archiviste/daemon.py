#!/usr/bin/env python3
"""
Archiviste Plus HTTP plugin daemon.
Registers with the claudeclaw-plus gateway and exposes three tools:
  archiviste_search, archiviste_index_status, archiviste_rebuild_index

Listens on localhost:5050 for inbound /invoke callbacks from the gateway.
Logs to ~/agent/logs/archiviste-daemon.log.
"""

import sys
import os
import json
import hmac
import hashlib
import sqlite3
import time
import logging
from datetime import datetime, timezone
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler

import requests

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from archiviste_vectorize import search as archiviste_search_fn, load_model, DB_PATH, VECTORS_DIR

# ── Config ────────────────────────────────────────────────────────────────────

PLUS_GATEWAY = "http://localhost:4632"
LISTEN_PORT = 5050
BOOTSTRAP_SECRET_PATH = os.path.expanduser("~/.config/plus/plugin-bootstrap.secret")
TOKEN_STORE_PATH = os.path.expanduser("~/.config/claudeclaw/archiviste.token")
LOG_PATH = os.path.expanduser("~/agent/logs/archiviste-daemon.log")

PLUGIN_MANIFEST = {
    "name": "archiviste",
    "version": "1.0.0",
    "schema_version": 1,
    "callback_url": f"http://localhost:{LISTEN_PORT}/invoke",
    "health_url": f"http://localhost:{LISTEN_PORT}/health",
    "tools": [
        {
            "name": "archiviste_search",
            "description": "Search indexed personal documents (invoices, T4, contracts, letters). Returns top-k results with path, score, snippet.",
            "schema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "k": {"type": "number"},
                    "trusted_only": {"type": "boolean"},
                },
                "required": ["query"],
            },
        },
        {
            "name": "archiviste_index_status",
            "description": "Return archiviste index statistics: total files, last vectorized timestamp, vector store size.",
            "schema": {"type": "object", "properties": {}},
        },
        {
            "name": "archiviste_rebuild_index",
            "description": "Rebuild the archiviste vector index for a directory (or full corpus). Returns count of indexed/skipped files.",
            "schema": {
                "type": "object",
                "properties": {"dir": {"type": "string"}},
            },
        },
    ],
    "capabilities": ["tools"],
}

logging.basicConfig(
    filename=LOG_PATH,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("archiviste-daemon")

# ── State ─────────────────────────────────────────────────────────────────────

_plugin_token: bytes = b""
_model = None


def get_model():
    global _model
    if _model is None:
        _model = load_model()
    return _model


# ── Registration ──────────────────────────────────────────────────────────────

def register_with_gateway() -> bool:
    if not os.path.exists(BOOTSTRAP_SECRET_PATH):
        log.error("Bootstrap secret not found at %s", BOOTSTRAP_SECRET_PATH)
        return False

    with open(BOOTSTRAP_SECRET_PATH, "rb") as f:
        bootstrap_hex = f.read().strip().hex() if not f.read(1) else f.seek(0) or f.read().hex()

    # Re-read properly
    with open(BOOTSTRAP_SECRET_PATH, "rb") as f:
        raw = f.read()
    bootstrap_hex = raw.hex()

    try:
        resp = requests.post(
            f"{PLUS_GATEWAY}/api/plugin/register",
            json=PLUGIN_MANIFEST,
            headers={"Authorization": f"Bearer {bootstrap_hex}"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        token_hex = data.get("plugin_token", "")
        if not token_hex:
            log.error("No plugin_token in registration response: %s", data)
            return False

        global _plugin_token
        _plugin_token = bytes.fromhex(token_hex)

        # Write token for greg-voice and other callers
        Path(TOKEN_STORE_PATH).parent.mkdir(parents=True, exist_ok=True)
        with open(TOKEN_STORE_PATH, "w") as f:
            f.write(token_hex)
        os.chmod(TOKEN_STORE_PATH, 0o640)

        log.info("Registered with gateway. Token stored at %s. Tools: %s",
                 TOKEN_STORE_PATH, data.get("registered_tools", []))
        return True
    except Exception as e:
        log.error("Registration failed: %s", e)
        return False


# ── HMAC verification ─────────────────────────────────────────────────────────

REPLAY_WINDOW_S = 15 * 60

def verify_hmac(body: bytes, ts: str, sig: str) -> bool:
    try:
        ts_dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        age = abs((datetime.now(timezone.utc) - ts_dt).total_seconds())
        if age > REPLAY_WINDOW_S:
            return False
    except Exception:
        return False

    expected = hmac.new(_plugin_token, f"{ts}\n{body.decode('utf-8')}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


# ── Tool implementations ───────────────────────────────────────────────────────

def _extract_excerpt(fpath: str, query: str, max_len: int = 400) -> str:
    """Read file and return an excerpt centered on the query match.

    Skips files >10 MB (too large to read for a snippet). Falls back to filename
    if file can't be read or has no text content. Returns up to ``max_len`` chars
    centered on the first case-insensitive match of ``query``; if no match, returns
    the leading ``max_len`` chars.
    """
    import os
    try:
        if os.path.getsize(fpath) > 10 * 1024 * 1024:
            return f"[{os.path.basename(fpath)}] (file too large for excerpt)"
        with open(fpath, "r", encoding="utf-8", errors="replace") as f:
            data = f.read(2 * 1024 * 1024)
        if not data.strip():
            return f"[{os.path.basename(fpath)}] (empty)"
        # Skip YAML frontmatter (Anthropic skills, markdown front-matter, etc.)
        # so the snippet shows the actual body instead of just metadata
        if data.startswith("---\n") or data.startswith("---\r\n"):
            end = data.find("\n---", 4)
            if 0 < end < 5000:
                data = data[end + 4:].lstrip()
        lower = data.lower()
        q_lower = query.lower().strip()
        idx = lower.find(q_lower) if q_lower else -1
        if idx >= 0:
            start = max(0, idx - max_len // 2)
            end = min(len(data), start + max_len)
            excerpt = data[start:end].replace("\n", " ").strip()
            prefix = "..." if start > 0 else ""
            suffix = "..." if end < len(data) else ""
            return prefix + excerpt + suffix
        excerpt = data[:max_len].replace("\n", " ").strip()
        return excerpt + ("..." if len(data) > max_len else "")
    except Exception as e:
        return f"[{os.path.basename(fpath)}] (excerpt unavailable: {type(e).__name__})"


def tool_archiviste_search(args: dict) -> dict:
    query = (args.get("query") or "").strip()
    if not query:
        return {"error": "query is required"}
    k = int(args.get("k", 10))
    trusted_only = bool(args.get("trusted_only", False))

    conn = sqlite3.connect(DB_PATH)
    try:
        model = get_model()
        raw = archiviste_search_fn(conn, model, query, top_k=k, exclude_untrusted=trusted_only)
        results = [
            {
                "path": r[1],
                "filename": str(r[2]) if len(r) > 2 else os.path.basename(r[1]),
                "score": round(float(r[0]), 4),
                "snippet": _extract_excerpt(r[1], query),
            }
            for r in raw
        ]
        return {"results": results}
    except Exception as e:
        return {"error": str(e)}
    finally:
        conn.close()


def tool_archiviste_index_status(_args: dict) -> dict:
    try:
        conn = sqlite3.connect(DB_PATH)
        total = conn.execute("SELECT COUNT(*) FROM files WHERE vectorized=1").fetchone()[0]
        last_row = conn.execute(
            "SELECT MAX(vectorized_at) FROM files WHERE vectorized=1"
        ).fetchone()
        last_ts = last_row[0] if last_row else None
        conn.close()
        vectors_dir = Path(VECTORS_DIR)
        store_bytes = sum(f.stat().st_size for f in vectors_dir.rglob("*") if f.is_file()) if vectors_dir.exists() else 0
        return {
            "total_files": total,
            "last_vectorized_at": last_ts,
            "store_size_mb": round(store_bytes / 1_048_576, 2),
        }
    except Exception as e:
        return {"error": str(e)}


def tool_archiviste_rebuild_index(args: dict) -> dict:
    t0 = time.time()
    target_dir = args.get("dir")
    try:
        import subprocess
        script = str(Path(__file__).parent.parent / "scripts" / "archiviste-vectorize.py")
        cmd = [sys.executable, script]
        if target_dir:
            cmd += ["--dir", target_dir]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        lines = result.stdout.splitlines()
        indexed = sum(1 for l in lines if "vectorise" in l.lower() or "indexed" in l.lower())
        skipped = sum(1 for l in lines if "skip" in l.lower())
        return {
            "indexed": indexed,
            "skipped": skipped,
            "duration_ms": int((time.time() - t0) * 1000),
        }
    except Exception as e:
        return {"error": str(e)}


TOOL_HANDLERS = {
    "archiviste_search": tool_archiviste_search,
    "archiviste_index_status": tool_archiviste_index_status,
    "archiviste_rebuild_index": tool_archiviste_rebuild_index,
}


# ── HTTP server ───────────────────────────────────────────────────────────────

class ArchivisteHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log.info(fmt, *args)

    def _send_json(self, data: dict, status: int = 200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json({"healthy": True, "plugin": "archiviste"})
        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path != "/invoke":
            self._send_json({"error": "not found"}, 404)
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        ts = self.headers.get("X-Plus-Ts", "")
        sig = self.headers.get("X-Plus-Signature", "")

        if not verify_hmac(body, ts, sig):
            self._send_json({"error": "invalid signature"}, 401)
            return

        try:
            payload = json.loads(body)
        except Exception:
            self._send_json({"error": "invalid JSON"}, 400)
            return

        tool_name = payload.get("tool", "")
        args = payload.get("args", {})
        # Unwrap if gateway double-wrapped (gateway passes raw body as args)
        if isinstance(args, dict) and "arguments" in args and len(args) == 1:
            args = args["arguments"]

        handler = TOOL_HANDLERS.get(tool_name)
        if not handler:
            self._send_json({"error": f"unknown tool: {tool_name}"}, 404)
            return

        try:
            result = handler(args)
            self._send_json({"result": result})
        except Exception as e:
            log.error("Tool %s error: %s", tool_name, e)
            self._send_json({"error": str(e)}, 500)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    log.info("Archiviste daemon starting on port %d", LISTEN_PORT)

    # Warm up model at startup so first search is fast
    try:
        get_model()
        log.info("Sentence transformer model loaded")
    except Exception as e:
        log.warning("Model preload failed: %s", e)

    # Register with gateway (retry up to 5 times with 2s backoff)
    for attempt in range(5):
        if register_with_gateway():
            break
        if attempt < 4:
            log.info("Retry registration in 2s (attempt %d/5)", attempt + 1)
            time.sleep(2)
    else:
        log.error("Could not register with gateway after 5 attempts — exiting")
        sys.exit(1)

    server = HTTPServer(("127.0.0.1", LISTEN_PORT), ArchivisteHandler)
    log.info("Listening on 127.0.0.1:%d", LISTEN_PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Archiviste daemon shutting down")
        server.server_close()


if __name__ == "__main__":
    main()
