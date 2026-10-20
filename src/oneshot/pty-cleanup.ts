import { realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeCwdForProjectsDir } from "../bus/jsonl-line-types.js";

/** Only called for the unique mkdtemp cwd owned by an untrusted one-shot. */
export function untrustedPtyProjectDir(
  cwd: string,
  configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
): string {
  return join(configDir, "projects", encodeCwdForProjectsDir(realpathSync(cwd)));
}

/** Interactive Claude ignores --no-session-persistence; retire it before cleanup. */
export function removeUntrustedPtyTranscripts(projectDir: string): void {
  rmSync(projectDir, { recursive: true, force: true });
}
