/**
 * Test preload (#304) — runs once, before any test file, for every `bun test`
 * whose cwd is the repo root (bunfig.toml `[test].preload`; bun reads bunfig
 * from the cwd only, so a `bun test` from a subdirectory runs without it).
 *
 * Two files in the operator's HOME were being written by ordinary test runs:
 * the plugin bridge's default audit journal (`~/.config/plus/plugin-audit.jsonl`,
 * seven suites through `getMcpBridge()`) and `~/.claude.json` (the PTY
 * supervisor heals the trust dialog for every spawn cwd — thousands of temp
 * `projects[...]` entries over time, parsed and backed up by claude on every
 * launch). `PLUS_PLUGIN_AUDIT_PATH` and `PLUS_CLAUDE_CONFIG_PATH` (read by
 * `PluginMcpBridge` and `ensureTrustAccepted`) point both at a temp dir for
 * the run. An explicit value in the environment wins, so a run that wants a
 * specific file can have one. The dir is removed when the process exits.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const need = !process.env.PLUS_PLUGIN_AUDIT_PATH || !process.env.PLUS_CLAUDE_CONFIG_PATH;
if (need) {
  const dir = mkdtempSync(join(tmpdir(), "ccaw-test-home-"));
  if (!process.env.PLUS_PLUGIN_AUDIT_PATH) {
    process.env.PLUS_PLUGIN_AUDIT_PATH = join(dir, "plugin-audit.jsonl");
  }
  if (!process.env.PLUS_CLAUDE_CONFIG_PATH) {
    process.env.PLUS_CLAUDE_CONFIG_PATH = join(dir, "claude.json");
  }
  process.on("exit", () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
}
