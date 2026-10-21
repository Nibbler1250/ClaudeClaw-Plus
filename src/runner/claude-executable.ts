/**
 * The claude binary to spawn. A leaf module so spawn sites outside the runner
 * (the one-shot print engine, the plugin CLI wrapper) can use it without
 * loading `runner.ts` and its dependencies. `runner.ts` re-exports
 * `claudeExecutable` and `_setClaudeExecutableForTests`.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * On Windows, `claude` resolves to `claude.cmd`, a batch wrapper that must
 * be run through cmd.exe (8191-char command-line limit). Resolving the
 * underlying `claude.exe` lets us call it directly via CreateProcessW
 * (32767-char limit). Required because --append-system-prompt + prompt
 * files + CLAUDE.md can easily exceed 8K.
 */
function resolveClaudeExecutable(): string {
  if (process.platform !== "win32") return "claude";
  try {
    const out = execSync("where claude", { encoding: "utf8" });
    const cmdPath = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.toLowerCase().endsWith(".cmd"));
    if (!cmdPath) return "claude";
    const exePath = join(
      dirname(cmdPath),
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    return existsSync(exePath) ? exePath : "claude";
  } catch {
    return "claude";
  }
}
export const CLAUDE_EXECUTABLE = resolveClaudeExecutable();
let claudeExecutableForTests: string | null = null;

/** The claude binary to spawn — `claude.exe` on Windows when it can be found,
 *  plain `"claude"` everywhere else. For spawn sites outside `runner.ts` (the
 *  interactive PTY, the bus session manager, the one-shot print engine, the
 *  plugin CLI wrapper): bun-pty cannot start the `claude.cmd` shim, and
 *  node's spawn does not run it without a shell. */
export function claudeExecutable(): string {
  return claudeExecutableForTests ?? CLAUDE_EXECUTABLE;
}

/** Test seam: make `claudeExecutable()` return `path` (null restores it). */
export function _setClaudeExecutableForTests(path: string | null): void {
  claudeExecutableForTests = path;
}
