import { spawn } from 'node:child_process';
import type { TunerConfig } from './config.js';

export type Role = 'intent_classifier' | 'detector' | 'proposer' | 'proposer_high_stakes' | 'judge';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface LLMClient {
  call(role: Role, system: string, messages: Message[], maxTokens?: number): Promise<string>;
  modelFor(role: Role): string;
}

function buildPrompt(system: string, messages: Message[]): string {
  const lines: string[] = ['[system]', system, '[/system]'];
  for (const m of messages) {
    lines.push('[' + m.role + ']', m.content, '[/' + m.role + ']');
  }
  return lines.join('\n');
}

export class ClaudeCliBackend implements LLMClient {
  private readonly models: TunerConfig['models'];

  constructor(config: TunerConfig) {
    this.models = config.models;
  }

  modelFor(role: Role): string {
    const m = this.models;
    return ({
      intent_classifier: m.intent_classifier,
      detector: m.detector,
      proposer: m.proposer_default,
      proposer_high_stakes: m.proposer_high_stakes,
      judge: m.judge,
    } as Record<Role, string>)[role];
  }

  async call(role: Role, system: string, messages: Message[], _maxTokens = 4096): Promise<string> {
    const model = this.modelFor(role);
    // Concatenate user-side messages; assistant turns are ignored (this client is single-turn).
    const userPrompt = messages.filter(m => m.role === 'user').map(m => m.content).join('\n\n');
    // claude CLI: --print for non-interactive, --model for routing, --append-system-prompt for
    // the system instructions (so they reach Claude as the system role rather than getting
    // stuffed into the user message). Bare-mode skips hooks/skills/keychain bookkeeping that
    // is irrelevant for a one-shot LLM call. Prompt content goes via stdin to dodge the
    // "Argument list too long" cliff on long system prompts.
    const args = ['--print', '--model', model, '--append-system-prompt', system];
    return new Promise((resolve, reject) => {
      const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      child.on('close', (code) => {
        if (code !== 0) reject(new Error('claude CLI exited ' + code + ': ' + err.slice(0, 200)));
        else resolve(out.trim());
      });
      child.on('error', reject);
      child.stdin.write(userPrompt);
      child.stdin.end();
    });
  }
}

export class AnthropicApiBackend implements LLMClient {
  private readonly models: TunerConfig['models'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;

  private readonly apiKey: string;

  constructor(config: TunerConfig) {
    this.models = config.models;
    this.apiKey = config.llm.api_key ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  }

  modelFor(role: Role): string {
    const m = this.models;
    return ({
      intent_classifier: m.intent_classifier,
      detector: m.detector,
      proposer: m.proposer_default,
      proposer_high_stakes: m.proposer_high_stakes,
      judge: m.judge,
    } as Record<Role, string>)[role];
  }

  async call(role: Role, system: string, messages: Message[], maxTokens = 4096): Promise<string> {
    if (!this.apiKey) {
      throw new Error('anthropic_api backend requires api_key in config or ANTHROPIC_API_KEY env var');
    }
    if (!this.client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
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
    return block && 'text' in block ? block.text : '';
  }
}

export function makeLLMClient(config: TunerConfig): LLMClient {
  // Auto-fall back to claude_cli when anthropic_api is selected but no key is available.
  // ProDesk-style deployments authenticate via OAuth/keychain through the claude CLI and
  // never set ANTHROPIC_API_KEY; without this fallback the engine silently uses the
  // static fallback alternatives because LLM construction throws and is caught upstream.
  if (config.llm.backend === 'anthropic_api') {
    const apiKey = config.llm.api_key ?? process.env['ANTHROPIC_API_KEY'];
    if (apiKey) return new AnthropicApiBackend(config);
    return new ClaudeCliBackend(config);
  }
  return new ClaudeCliBackend(config);
}
