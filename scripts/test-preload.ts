/**
 * Test preload (#304) — runs once, before any test file, for every `bun test`
 * whose cwd is the repo root (bunfig.toml `[test].preload`).
 *
 * The plugin bridge's default audit journal is the OPERATOR's
 * `~/.config/plus/plugin-audit.jsonl`; seven suites reach it through
 * `getMcpBridge()` and were appending test-shaped entries to a live file on
 * every run. `PLUS_PLUGIN_AUDIT_PATH` (read by `PluginMcpBridge`) points
 * them at a temp file for the run instead. An explicit value in the
 * environment wins, so a run that wants a specific journal can have one.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PLUS_PLUGIN_AUDIT_PATH) {
  const dir = mkdtempSync(join(tmpdir(), "ccaw-test-audit-"));
  process.env.PLUS_PLUGIN_AUDIT_PATH = join(dir, "plugin-audit.jsonl");
}
