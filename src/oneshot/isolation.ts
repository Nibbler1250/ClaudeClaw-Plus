/**
 * The one isolation rule for one-shot `claude` calls that read untrusted text
 * (#548). Every claude engine appends these flags for `isolation: "untrusted"`;
 * no caller keeps its own list.
 *
 * - `--tools ""`: no built-in tool at all.
 * - `--strict-mcp-config` with no `--mcp-config`: no MCP server.
 * - `--setting-sources ""`: no settings file, so no hooks and no user plugins.
 * - `--no-session-persistence`: nothing saved to resume later.
 * - `--disable-slash-commands`: no skills or commands.
 *
 * `--tools` is variadic: anything placed after it that does not start with a
 * dash is read as a tool name, so the prompt must come before these flags.
 */
export const UNTRUSTED_CLAUDE_ARGS: readonly string[] = Object.freeze([
  "--tools",
  "",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--no-session-persistence",
  "--disable-slash-commands",
]);

/**
 * Whether the interactive CLI (the `pty` engine) is known to honour
 * `UNTRUSTED_CLAUDE_ARGS` the way `-p` does, and not to stop on the trust
 * dialog in an empty temp cwd. Not checked yet, so an untrusted route cannot
 * use `pty`: `runOneShot` refuses it and the `oneShot` settings fail to load.
 * Flipped by the change that carries the check, not by configuration.
 */
export const PTY_UNTRUSTED_VERIFIED = false;
