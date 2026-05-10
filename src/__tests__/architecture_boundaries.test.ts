/**
 * Architecture boundary test: fails if any file outside the allowlist imports
 * skills-tuner internals directly. New code consuming the tuner inside a Claude
 * Code session MUST go through the MCP bridge (claudeclaw-plus / tuner_* tools).
 *
 * Sanctioned locations:
 *   src/skills-tuner/**        — internal implementation
 *   src/plugins/skills-tuner/** — the bridge plugin (the only external consumer)
 *   src/__tests__/**           — tests are allowed to import anything
 *   scripts/**                 — migration / one-off scripts
 */

import { describe, it, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");

const ALLOWLIST_PREFIXES = [
  "src/skills-tuner/",
  "src/plugins/skills-tuner/",
  "src/__tests__/",
  "scripts/",
];

const TUNER_INTERNAL_PATTERN =
  /from\s+['"][^'"]*skills-tuner\/(core|cli|subjects|storage|git_ops)[^'"]*['"]/;

function listTs(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => !e.isDirectory() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath ?? dir, e.name));
}

describe("Architecture boundaries", () => {
  it("no file outside the allowlist imports skills-tuner internals directly", () => {
    const violations: string[] = [];

    for (const absPath of listTs(SRC)) {
      const rel = relative(ROOT, absPath).replace(/\\/g, "/");
      if (ALLOWLIST_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;

      const content = readFileSync(absPath, "utf8");
      if (TUNER_INTERNAL_PATTERN.test(content)) {
        violations.push(rel);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Files importing skills-tuner internals outside the allowlist:\n` +
          violations.map((v) => `  - ${v}`).join("\n") +
          `\n\nNew code consuming the tuner MUST use the MCP bridge (claudeclaw-plus, tuner_* tools).` +
          `\nAllowlisted paths: ${ALLOWLIST_PREFIXES.join(", ")}`,
      );
    }

    expect(violations.length).toBe(0);
  });
});
