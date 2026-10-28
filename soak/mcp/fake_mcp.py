#!/usr/bin/python3 -I
"""Fake stdio MCP server for the soak harness. Behaviour comes from the executable name (argv[0] basename,
which is also the process comm the pilot uses to find it):
  mcp-ok    : exits on SIGTERM, SIGHUP or stdin EOF (a normal server)
  mcp-lent  : on SIGTERM waits ~5 s then exits; ignores SIGHUP and stdin EOF (slow to exit)
  mcp-sourd : ignores SIGTERM, SIGHUP and stdin EOF; only SIGKILL stops it (deaf to SIGTERM)
One tool: echo.
Keep the shebang a direct interpreter path (not /usr/bin/env): with env the process comm becomes "python3"
and the pilot can no longer identify the servers."""
import json, os, signal, sys, threading, time
kind = os.path.basename(sys.argv[0])
if kind == "mcp-lent":
    def slow(*_):
        time.sleep(5)
        os._exit(0)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=slow, daemon=False).start())
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
elif kind == "mcp-sourd":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
def send(o):
    try:
        sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
    except OSError:
        pass
for line in sys.stdin:
    try:
        m = json.loads(line)
    except ValueError:
        continue
    i, meth = m.get("id"), m.get("method")
    if i is None:
        continue
    if meth == "initialize":
        send({"jsonrpc": "2.0", "id": i, "result": {"protocolVersion": (m.get("params") or {}).get("protocolVersion", "2024-11-05"),
              "capabilities": {"tools": {}}, "serverInfo": {"name": kind, "version": "1"}}})
    elif meth == "tools/list":
        send({"jsonrpc": "2.0", "id": i, "result": {"tools": [{"name": "echo", "description": "Echo text back",
              "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}}}]}})
    elif meth == "tools/call":
        t = ((m.get("params") or {}).get("arguments") or {}).get("text", "")
        send({"jsonrpc": "2.0", "id": i, "result": {"content": [{"type": "text", "text": t}]}})
    else:
        send({"jsonrpc": "2.0", "id": i, "error": {"code": -32601, "message": "method not found"}})
if kind != "mcp-ok":
    while True:  # stdin EOF ignored
        time.sleep(3600)
