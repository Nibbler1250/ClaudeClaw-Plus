import { cleanSpawnEnv } from "../runner/spawn-env";
import type { OneShotContext, OneShotEngine, OneShotRequest, OneShotResult } from "./engine";
import { UNTRUSTED_CLAUDE_ARGS } from "./isolation";

/** Alias routed by env (base URL), not by `--model`, as the PTY argv has it. */
const ENV_ROUTED_MODELS = new Set(["glm"]);
/** Per stream. Past it, output is dropped, as `runClaudeOnce` caps it. */
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

/**
 * `claude -p` argv for a request. The prompt goes right after `-p`, ahead of
 * the variadic `--tools`. `-p` takes no value, so the prompt is a positional
 * argument: one that starts with a dash would be parsed as a flag, and gets a
 * leading space instead.
 */
export function printArgs(req: OneShotRequest): string[] {
  const prompt = req.prompt.startsWith("-") ? ` ${req.prompt}` : req.prompt;
  const args = ["-p", prompt];
  const model = req.model?.trim();
  if (model && !ENV_ROUTED_MODELS.has(model.toLowerCase())) args.push("--model", model);
  if (req.system) args.push("--system-prompt", req.system);
  if (req.isolation === "untrusted") {
    args.push(...UNTRUSTED_CLAUDE_ARGS);
    return args;
  }
  if (req.resumeSessionId) args.push("--resume", req.resumeSessionId);
  if (req.allowedTools && req.allowedTools.length > 0) {
    args.push("--allowedTools", req.allowedTools.join(" "));
  }
  return args;
}

/**
 * `claude -p`, the supported non-interactive mode. Timeout and abort kill the
 * child (SIGTERM, then SIGKILL after 5 s) and return exit 124 / 130, like
 * `runClaudeOnce`. A spawn failure (no `claude` on PATH) rejects.
 */
export const printEngine: OneShotEngine = {
  id: "print",
  caps: { resume: true, tools: true, isolation: true },
  run(req: OneShotRequest, ctx: OneShotContext): Promise<Omit<OneShotResult, "engine">> {
    return new Promise((resolve, reject) => {
      const model = req.model?.trim() || undefined;
      if (req.signal?.aborted) {
        resolve({ text: "", model, exitCode: 130, stderr: "aborted" });
        return;
      }
      const child = ctx.spawn("claude", printArgs(req), {
        stdio: ["ignore", "pipe", "pipe"],
        env: req.env ?? cleanSpawnEnv(),
        ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
      });
      let out = "";
      let err = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (exitCode: number, stderr: string): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        resolve({ text: out.trim(), model, exitCode, stderr });
      };
      const kill = (exitCode: number, why: string): void => {
        try {
          child.kill?.("SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            child.kill?.("SIGKILL");
          } catch {}
        }, 5000).unref?.();
        out = "";
        finish(exitCode, why);
      };
      const onAbort = (): void => kill(130, "aborted");
      timer = setTimeout(
        () => kill(124, `claude -p timed out after ${req.timeoutMs / 1000}s`),
        req.timeoutMs,
      );
      req.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (d: Buffer) => {
        if (out.length < MAX_OUTPUT_CHARS) out += d.toString();
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (err.length < MAX_OUTPUT_CHARS) err += d.toString();
      });
      child.on("close", (code: number | null) => finish(code ?? 1, err));
      child.on("error", (e: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        reject(e);
      });
    });
  },
};
