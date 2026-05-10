/**
 * Minimal JSON-RPC MCP server for testing.
 * Reads from stdin, writes to stdout (line-delimited JSON).
 * Responds to: initialize, notifications/initialized, tools/list, tools/call
 */

const TOOLS = [
  {
    name: "echo",
    description: "Echo args as JSON",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "slow_tool",
    description: "Sleeps 5 seconds then echoes",
    inputSchema: { type: "object", properties: { message: { type: "string" } } },
  },
  {
    name: "secret_tool",
    description: "Should be filtered by allowedTools",
    inputSchema: { type: "object" },
  },
];

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line) as { id?: unknown; method?: string; params?: unknown };
      handleMessage(msg);
    } catch {
      // ignore parse errors
    }
  }
});

function handleMessage(msg: { id?: unknown; method?: string; params?: unknown }): void {
  const { id, method } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp-server", version: "1.0.0" },
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    // no response needed for notifications
    return;
  }

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  if (method === "tools/call") {
    const params = msg.params as { name?: string; arguments?: unknown };
    const name = params?.name;

    if (name === "echo") {
      const args = params?.arguments as { message?: string };
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify({ echo: args?.message ?? "" }) }] },
      });
      return;
    }

    if (name === "slow_tool") {
      const args = params?.arguments as { message?: string };
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify({ slow: args?.message ?? "" }) }] },
        });
      }, 5_000);
      return;
    }

    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    });
    return;
  }

  // Unknown method
  if (id !== undefined && id !== null) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } });
  }
}

process.stdin.resume();
