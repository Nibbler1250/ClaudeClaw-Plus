import type { OneShotContext, OneShotEngine, OneShotRequest, OneShotResult } from "./engine";
import { PTY_UNTRUSTED_VERIFIED } from "./isolation";

export interface PtyOnceRequest {
  prompt: string;
  timeoutMs: number;
  modelOverride?: string;
  signal?: AbortSignal;
  cwd?: string;
  untrusted: boolean;
  resumeSessionId?: string;
}
export type PtyOnceRunner = (
  req: PtyOnceRequest,
) => Promise<{ rawStdout: string; stderr: string; exitCode: number; sessionId?: string }>;

let _runnerForTests: PtyOnceRunner | null = null;
/** Test seam: replaces `runOnceOnPty`, so no test spawns a real PTY. */
export function _setPtyOnceRunnerForTests(fn: PtyOnceRunner | null): void {
  _runnerForTests = fn;
}

/**
 * The interactive CLI on an ephemeral PTY (`runOnceOnPty`): fresh session or
 * `--resume`, one turn, PTY retired. Outside the supervisor's LRU and cap.
 * Cannot run untrusted routes until `PTY_UNTRUSTED_VERIFIED`. Tools follow the
 * operator's security settings, so `allowedTools` is not taken.
 */
export const ptyEngine: OneShotEngine = {
  id: "pty",
  caps: { resume: true, tools: false, isolation: PTY_UNTRUSTED_VERIFIED },
  async run(req: OneShotRequest, ctx: OneShotContext): Promise<Omit<OneShotResult, "engine">> {
    // Lazy: loading the supervisor pulls in the runner; the tuner CLI must not.
    const run = _runnerForTests ?? (await import("../runner/pty-supervisor")).runOnceOnPty;
    const model = req.model?.trim() || undefined;
    const exec = await run({
      // The interactive CLI has no --system-prompt replacement: it leads the turn.
      prompt: req.system ? `${req.system}\n\n${req.prompt}` : req.prompt,
      timeoutMs: req.timeoutMs,
      modelOverride: model,
      signal: req.signal,
      cwd: ctx.cwd,
      untrusted: req.isolation === "untrusted",
      ...(req.resumeSessionId ? { resumeSessionId: req.resumeSessionId } : {}),
    });
    return {
      text: exec.rawStdout.trim(),
      model,
      exitCode: exec.exitCode,
      stderr: exec.stderr,
      ...(exec.sessionId ? { sessionId: exec.sessionId } : {}),
    };
  },
};
