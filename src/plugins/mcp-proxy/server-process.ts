import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  allowedTools?: string[];
}

export interface ServerTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type ServerStatus = "starting" | "up" | "crashed" | "restarting" | "failed" | "stopped";

const BACKOFF_MS = [1_000, 5_000, 30_000, 60_000];
const CRASH_WINDOW_MS = 5 * 60 * 1_000;
const MAX_CRASHES_IN_WINDOW = 5;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export class McpServerProcess {
  readonly name: string;
  private config: McpServerConfig;

  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  status: ServerStatus = "starting";
  tools: ServerTool[] = [];
  startedAt: Date | null = null;
  lastInvocationAt: Date | null = null;

  private crashTimestamps: number[] = [];
  private crashCount = 0;
  private restartHook?: (name: string, reason: string) => void;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(name: string, config: McpServerConfig, opts?: {
    onCrash?: (name: string, reason: string) => void;
  }) {
    this.name = name;
    this.config = config;
    this.restartHook = opts?.onCrash;
  }

  async start(): Promise<void> {
    this.status = "starting";
    const logDir = join(homedir(), ".cache", "claudeclaw", "mcp-proxy");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `${this.name}.log`);

    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      env: this.config.env,
      stderr: "pipe",
    });

    // Pipe stderr to log file — transport.stderr is available immediately when stderr:"pipe"
    const stderrStream = this.transport.stderr;
    if (stderrStream) {
      const logStream = createWriteStream(logPath, { flags: "a" });
      stderrStream.pipe(logStream);
    }

    this.client = new Client(
      { name: `mcp-proxy/${this.name}`, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );

    this.transport.onclose = () => this._handleCrash("transport closed");
    this.transport.onerror = (err) => this._handleCrash(`transport error: ${err.message}`);

    await this.client.connect(this.transport);

    const { tools } = await this.client.listTools();
    const allowed = this.config.allowedTools;
    this.tools = tools
      .filter((t) => !allowed || allowed.includes(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
      }));

    this.status = "up";
    this.startedAt = new Date();
  }

  async call(tool: string, args: unknown, timeoutMs = DEFAULT_CALL_TIMEOUT_MS): Promise<unknown> {
    if (!this.client || this.status !== "up") {
      throw new Error(`Server ${this.name} is not ready (status: ${this.status})`);
    }
    this.lastInvocationAt = new Date();

    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tool call ${tool} timed out after ${timeoutMs}ms`)), timeoutMs),
    );

    const call = this.client.callTool({
      name: tool,
      arguments: args as Record<string, unknown>,
    });

    const result = await Promise.race([call, timer]);
    const content = (result as { content?: Array<{ text?: string }> }).content?.[0];
    const text = content?.text ?? "";
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.status = "stopped";
    try {
      await this.client?.close();
    } catch {}
    try {
      await this.transport?.close();
    } catch {}
    this.client = null;
    this.transport = null;
  }

  private _handleCrash(reason: string): void {
    if (this.stopping || this.status === "failed" || this.status === "stopped") return;
    this.status = "crashed";
    this.crashCount++;
    const now = Date.now();
    this.crashTimestamps = [...this.crashTimestamps, now].filter((t) => now - t < CRASH_WINDOW_MS);

    this.restartHook?.(this.name, reason);

    if (this.crashTimestamps.length >= MAX_CRASHES_IN_WINDOW) {
      this.status = "failed";
      return;
    }

    const backoff = BACKOFF_MS[Math.min(this.crashCount - 1, BACKOFF_MS.length - 1)] ?? 60_000;
    this.status = "restarting";
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this._doRestart();
    }, backoff);
  }

  private async _doRestart(): Promise<void> {
    try {
      this.client = null;
      this.transport = null;
      await this.start();
    } catch (err) {
      this._handleCrash(`restart failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
