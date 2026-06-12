"""Tests for archiviste daemon HTTP plugin."""
import json
import hmac as _hmac
import hashlib
import time
import sys
import os
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from pathlib import Path
from http.server import HTTPServer
import threading

sys.path.insert(0, str(Path(__file__).parent.parent))

# Patch heavy imports before loading daemon
with patch.dict(sys.modules, {
    "archiviste_vectorize": MagicMock(
        search=lambda conn, model, q, top_k=10, **kw: [],
        load_model=lambda: MagicMock(),
        DB_PATH="/tmp/test-archiviste.db",
        VECTORS_DIR="/tmp/test-archiviste-vectors",
    ),
    "sentence_transformers": MagicMock(),
}):
    import daemon as archiviste_daemon


# ── Helpers ───────────────────────────────────────────────────────────────────

def make_token() -> bytes:
    import secrets
    return secrets.token_bytes(32)


def sign(token: bytes, body: str, ts: str) -> str:
    return _hmac.new(token, f"{ts}\n{body}".encode(), hashlib.sha256).hexdigest()


def invoke(handler_cls, token: bytes, tool: str, args: dict) -> dict:
    """Simulate a gateway callback invocation."""
    body = json.dumps({"tool": tool, "args": args}).encode()
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    sig = sign(token, body.decode(), ts)

    class FakeRequest:
        headers = {"Content-Length": str(len(body)), "X-Plus-Ts": ts, "X-Plus-Signature": sig}
        def read(self, n): return body

    responses = []

    class FakeHandler(archiviste_daemon.ArchivisteHandler):
        def __init__(self):
            self.path = "/invoke"
            self.rfile = FakeRequest()
            self.headers = self.rfile.headers

        def _send_json(self, data, status=200):
            responses.append((status, data))

        def send_response(self, *a): pass
        def send_header(self, *a): pass
        def end_headers(self): pass
        def log_message(self, *a): pass

    archiviste_daemon._plugin_token = token
    FakeHandler().do_POST()
    return responses[0] if responses else (None, None)


# ── Test 1 — register flow returns token ──────────────────────────────────────

def test_register_flow_returns_token(tmp_path, monkeypatch):
    """Register endpoint returns plugin_token and stores it."""
    token_path = tmp_path / "archiviste.token"
    monkeypatch.setattr(archiviste_daemon, "TOKEN_STORE_PATH", str(token_path))

    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {"plugin_token": "deadbeef" * 8, "registered_tools": ["archiviste__archiviste_search"]}

    bootstrap_file = tmp_path / "bootstrap.secret"
    bootstrap_file.write_bytes(b"\x00" * 32)
    monkeypatch.setattr(archiviste_daemon, "BOOTSTRAP_SECRET_PATH", str(bootstrap_file))

    with patch.object(archiviste_daemon.requests, "post", return_value=mock_resp):
        result = archiviste_daemon.register_with_gateway()

    assert result is True
    assert token_path.read_text().strip() == "deadbeef" * 8
    assert archiviste_daemon._plugin_token == bytes.fromhex("deadbeef" * 8)


# ── Test 2 — valid HMAC + valid tool + args returns result ────────────────────

def test_invoke_valid_hmac_returns_result():
    token = make_token()
    with patch.object(archiviste_daemon, "tool_archiviste_search", return_value={"results": []}):
        status, data = invoke(archiviste_daemon.ArchivisteHandler, token, "archiviste_search", {"query": "T4"})
    assert status == 200
    assert "result" in data


# ── Test 3 — invalid HMAC → 401 ───────────────────────────────────────────────

def test_invoke_invalid_hmac_returns_401():
    token = make_token()
    wrong_token = make_token()  # different token

    body = json.dumps({"tool": "archiviste_search", "args": {"query": "T4"}}).encode()
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    bad_sig = sign(wrong_token, body.decode(), ts)

    class FakeRequest:
        headers = {"Content-Length": str(len(body)), "X-Plus-Ts": ts, "X-Plus-Signature": bad_sig}
        def read(self, n): return body

    responses = []

    class FakeHandler(archiviste_daemon.ArchivisteHandler):
        def __init__(self):
            self.path = "/invoke"
            self.rfile = FakeRequest()
            self.headers = self.rfile.headers

        def _send_json(self, data, status=200):
            responses.append((status, data))

        def send_response(self, *a): pass
        def send_header(self, *a): pass
        def end_headers(self): pass
        def log_message(self, *a): pass

    archiviste_daemon._plugin_token = token
    FakeHandler().do_POST()
    status, data = responses[0]
    assert status == 401


# ── Test 4 — unknown tool → 404 with structured error ────────────────────────

def test_invoke_unknown_tool_returns_404():
    token = make_token()
    status, data = invoke(archiviste_daemon.ArchivisteHandler, token, "non_existent_tool", {})
    assert status == 404
    assert "error" in data


# ── Test 5 — search returns {results: [...]} even on empty corpus ─────────────

def test_search_returns_shape_on_empty_corpus(monkeypatch):
    """Empty corpus returns {results: []} not an error."""
    import sqlite3
    monkeypatch.setattr(archiviste_daemon, "archiviste_search_fn", lambda *a, **kw: [])

    with patch("sqlite3.connect", return_value=MagicMock(
        execute=MagicMock(return_value=MagicMock(fetchone=lambda: [0], fetchall=lambda: [])),
        close=MagicMock(),
    )):
        result = archiviste_daemon.tool_archiviste_search({"query": "anything"})

    assert "results" in result
    assert isinstance(result["results"], list)
