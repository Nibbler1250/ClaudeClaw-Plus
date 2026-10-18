import type { spawn } from "node:child_process";
import { runOneShot } from "../../oneshot/engine.js";
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

/** The one-shot route of each tuner role (#548). */
const ROUTE_OF_ROLE: Record<Role, string> = {
  intent_classifier: "tuner.classify",
  detector: "tuner.detect",
  proposer: "tuner.propose",
  proposer_high_stakes: "tuner.propose",
  judge: "tuner.judge",
};

/** Bounds a tuner call; the CLI backend used to wait for ever. */
const TUNER_CALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The tuner's calls through `runOneShot` (#548). The prompt carries untrusted
 * text (conversation turns, skill bodies), so every call runs `untrusted`: no
 * built-in tools, no MCP servers, no settings file, no saved session, no slash
 * commands, from an empty temp cwd. With no configured model, or an env-routed
 * alias, --model is left out and the CLI's default applies. The engine is the
 * route's (`print` unless `oneShot.routes` says otherwise); the child env is
 * `cleanSpawnEnv()`.
 */
export class OneShotBackend implements LLMClient {
  private readonly models: TunerConfig["models"];

  constructor(
    config: TunerConfig,
    private readonly spawnFn?: typeof spawn,
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

  // The claude engines have no output-length flag, so maxTokens is accepted
  // for interface compatibility but not forwarded.
  async call(
    role: Role,
    system: string,
    messages: Message[],
    _maxTokens?: number,
  ): Promise<string> {
    const res = await runOneShot(
      {
        route: ROUTE_OF_ROLE[role],
        prompt: buildPrompt(system, messages),
        model: this.modelFor(role),
        isolation: "untrusted",
        timeoutMs: TUNER_CALL_TIMEOUT_MS,
      },
      this.spawnFn ? { spawn: this.spawnFn } : {},
    );
    if (res.exitCode !== 0) {
      throw new Error("claude CLI exited " + res.exitCode + ": " + res.stderr.slice(0, 200));
    }
    return res.text;
  }
}

/** `claude_cli`: the `oneshot` backend under its old name. */
export class ClaudeCliBackend extends OneShotBackend {}

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
  return new OneShotBackend(config);
}
