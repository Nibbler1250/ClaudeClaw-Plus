/**
 * Bus MCP client — IPC reconnection (issue #222).
 *
 * Regression guard for the control-plane wedge: the mcp-server connected to
 * Bus core exactly once and never reconnected, so a socket drop (with the
 * process still alive) severed the link forever — `sendPrompt` logged
 * "No MCP connection" and outbound `reply` frames vanished. The transport now
 * re-dials with backoff and fires `onConnect` so the owner re-handshakes.
 *
 * These tests stand up a real UDS server (`Bun.listen`) so the reconnect is
 * exercised end-to-end over the OS socket, not a fake.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket as BunSocket } from "bun";
import { connectBusIpc, type IpcTransport } from "../mcp-server";

const IS_UNIX = process.platform !== "win32";

async function waitUntil(pred: () => boolean, timeoutMs = 2500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 15));
  }
}

interface ServerState {
  buf: Buffer;
}

/** Minimal length-prefixed frame counter for the server side of the test. */
function countFrames(state: ServerState, chunk: Buffer, onFrame: () => void): void {
  state.buf = Buffer.concat([state.buf, Buffer.from(chunk)]);
  while (state.buf.length >= 4) {
    const len = state.buf.readUInt32BE(0);
    if (state.buf.length < 4 + len) return;
    state.buf = state.buf.subarray(4 + len);
    onFrame();
  }
}

describe("Bus MCP IPC reconnection (#222)", () => {
  if (!IS_UNIX) {
    it.skip("skipped on non-Unix", () => {});
    return;
  }

  let tempDir: string | null = null;
  let transport: IpcTransport | null = null;
  let server: { stop(): void } | null = null;

  afterEach(async () => {
    if (transport) {
      await transport.close().catch(() => undefined);
      transport = null;
    }
    if (server) {
      try {
        server.stop();
      } catch {
        /* ignore */
      }
      server = null;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("re-dials and re-fires onConnect after the server drops the socket", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "ccaw-ipc-reconnect-"));
    const sockPath = join(tempDir, "bus.sock");

    let opens = 0;
    let lastServerSock: BunSocket<ServerState> | null = null;
    server = Bun.listen<ServerState>({
      unix: sockPath,
      socket: {
        open(s) {
          opens += 1;
          s.data = { buf: Buffer.alloc(0) };
          lastServerSock = s;
        },
        data() {},
        close() {},
      },
    });

    transport = await connectBusIpc({ CCAW_BUS_SOCK: sockPath } as NodeJS.ProcessEnv);

    // onConnect must fire on RECONNECTS only — not the first connect (which
    // resolved the boot promise above). The owner re-handshakes here.
    let reconnects = 0;
    transport.onConnect?.(() => {
      reconnects += 1;
    });

    await waitUntil(() => opens === 1);
    expect(reconnects).toBe(0);

    // Server drops the accepted connection — the client's socket sees 'close'.
    expect(lastServerSock).not.toBeNull();
    (lastServerSock as unknown as { end(): void }).end();

    // Client re-dials (backoff base 250ms) → second accept + one onConnect.
    await waitUntil(() => opens === 2 && reconnects === 1, 4000);
    expect(opens).toBe(2);
    expect(reconnects).toBe(1);
  });

  it("delivers frames again after a reconnect (the channel is restored, not just re-opened)", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "ccaw-ipc-reconnect-"));
    const sockPath = join(tempDir, "bus.sock");

    let framesAfterReconnect = 0;
    let opens = 0;
    let lastServerSock: BunSocket<ServerState> | null = null;
    server = Bun.listen<ServerState>({
      unix: sockPath,
      socket: {
        open(s) {
          opens += 1;
          s.data = { buf: Buffer.alloc(0) };
          lastServerSock = s;
        },
        data(s, chunk) {
          if (opens >= 2) {
            countFrames(s.data, Buffer.from(chunk), () => {
              framesAfterReconnect += 1;
            });
          }
        },
        close() {},
      },
    });

    transport = await connectBusIpc({ CCAW_BUS_SOCK: sockPath } as NodeJS.ProcessEnv);
    // Re-handshake on reconnect, exactly like BusMcpServer.wireIpc does.
    transport.onConnect?.(() => {
      transport?.send({ type: "hello", agent_id: "default", capabilities: ["claude/channel"] });
    });

    await waitUntil(() => opens === 1);
    (lastServerSock as unknown as { end(): void }).end();
    await waitUntil(() => opens === 2);

    // The reconnect's onConnect already sent a hello; send one more frame to
    // confirm the live socket carries traffic post-reconnect.
    await waitUntil(() => framesAfterReconnect >= 1, 4000);
    transport.send({ type: "reply", agent_id: "default", text: "ok", intent: "final" });
    await waitUntil(() => framesAfterReconnect >= 2, 4000);
    expect(framesAfterReconnect).toBeGreaterThanOrEqual(2);
  });

  it("send() while disconnected drops cleanly instead of throwing", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "ccaw-ipc-reconnect-"));
    const sockPath = join(tempDir, "bus.sock");

    let lastServerSock: BunSocket<ServerState> | null = null;
    server = Bun.listen<ServerState>({
      unix: sockPath,
      socket: {
        open(s) {
          s.data = { buf: Buffer.alloc(0) };
          lastServerSock = s;
        },
        data() {},
        close() {},
      },
    });

    transport = await connectBusIpc({ CCAW_BUS_SOCK: sockPath } as NodeJS.ProcessEnv);
    await waitUntil(() => lastServerSock !== null);
    (lastServerSock as unknown as { end(): void }).end();

    // Immediately after the drop, before the backoff re-dial completes, a send
    // must NOT throw (it would surface as an MCP tool error / unhandled
    // rejection in production). It logs + drops.
    expect(() =>
      transport?.send({ type: "reply", agent_id: "default", text: "x", intent: "final" }),
    ).not.toThrow();
  });
});
