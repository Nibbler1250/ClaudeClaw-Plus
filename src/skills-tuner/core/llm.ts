import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanSpawnEnv } from "../../runner/spawn-env.js";
import type { TunerConfig } from "./config.js";

export type Role = "intent_classifier" | "detector" | "proposer" | "proposer_high_stakes" | "judge";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface LLMClient {
  call(role: Role, system: string, messages: Message[], maxTokens?: number): Promise<string>;
  modelFor(role: Role): string;
}

function buildPrompt(system: string, messages: Message[]): string {
  const lines: string[] = ["[system]", system, "[/system]"];
  for (const m of messages) {
    lines.push("[" + m.role + "]", m.content, "[/" + m.role + "]");
  }
  return lines.join("\n");
}

/**
 * Arguments for a one-shot `claude -p` call. The prompt carries untrusted text
 * (conversation turns, skill bodies), so the call runs with no built-in tools,
 * no MCP servers, no settings file (`--setting-sources ""`: no hooks, no user
 * plugins), no saved session and no slash commands — the same set as the
 * Discord classifier's `CLASSIFIER_ARGS`. With no configured model, or the
 * env-routed "glm" alias, --model is left out and the CLI's default applies
 * (same rule as the runner's spawn sites).
 */
export function cliArgs(prompt: string, model: string | undefined): string[] {
  const args = ["-p", prompt];
  const m = model?.trim();
  if (m && m.toLowerCase() !== "glm") args.push("--model", m);
  args.push(
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--disable-slash-commands",
  );
  return args;
}

export class ClaudeCliBackend implements LLMClient {
  private readonly models: TunerConfig["models"];

  constructor(
    config: TunerConfig,
    private readonly spawnFn: typeof spawn = spawn,
  ) {
    this.models = config.models;
  }

  modelFor(role: Role): string {
    const m = this.models;
    return (
      {
        intent_classifier: m.intent_classifier,
        detector: m.detector,
        proposer: m.proposer_default,
        proposer_high_stakes: m.proposer_high_stakes,
        judge: m.judge,
      } as Record<Role, string>
    )[role];
  }

  // The claude CLI has no output-length flag, so maxTokens is accepted for
  // interface compatibility but not forwarded.
  async call(
    role: Role,
    system: string,
    messages: Message[],
    _maxTokens?: number,
  ): Promise<string> {
    const prompt = buildPrompt(system, messages);
    // Empty cwd, so no project dir is ever in reach of the call. Removed once
    // the child is done, whatever the outcome; a failed removal (Windows file
    // lock) must not replace the result.
    const cwd = mkdtempSync(join(tmpdir(), "claudeclaw-tuner-"));
    const cleanup = () => {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // best effort
      }
    };
    return new Promise<string>((resolve, reject) => {
      const child = this.spawnFn("claude", cliArgs(prompt, this.modelFor(role)), {
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanSpawnEnv(),
        cwd,
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        err += d.toString();
      });
      child.on("close", (code) => {
        if (code !== 0) reject(new Error("claude CLI exited " + code + ": " + err.slice(0, 200)));
        else resolve(out.trim());
      });
      child.on("error", reject);
    }).finally(cleanup);
  }
}

export class AnthropicApiBackend implements LLMClient {
  private readonly models: TunerConfig["models"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;

  private readonly apiKey: string;

  constructor(config: TunerConfig) {
    this.models = config.models;
    const apiKey = config.llm.api_key ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey)
      throw new Error(
        "anthropic_api backend requires api_key in config or ANTHROPIC_API_KEY env var",
      );
    this.apiKey = apiKey;
  }

  modelFor(role: Role): string {
    const m = this.models;
    return (
      {
        intent_classifier: m.intent_classifier,
        detector: m.detector,
        proposer: m.proposer_default,
        proposer_high_stakes: m.proposer_high_stakes,
        judge: m.judge,
      } as Record<Role, string>
    )[role];
  }

  async call(role: Role, system: string, messages: Message[], maxTokens = 4096): Promise<string> {
    if (!this.client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this.client = new Anthropic({ apiKey: this.apiKey, maxRetries: 4 });
    }
    const model = this.modelFor(role);
    const response = await this.client.messages.create({
      model,
      system,
      messages: messages.map((m: Message) => ({ role: m.role, content: m.content })),
      max_tokens: maxTokens,
    });
    const block = response.content[0];
    return block && "text" in block ? block.text : "";
  }
}

export function makeLLMClient(config: TunerConfig): LLMClient {
  if (config.llm.backend === "anthropic_api") return new AnthropicApiBackend(config);
  return new ClaudeCliBackend(config);
}
