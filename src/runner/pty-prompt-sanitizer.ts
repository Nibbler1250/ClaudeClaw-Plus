/**
 * Standalone prompt sanitiser for any path that writes user text to a PTY's
 * stdin. Lives in its own file (no `bun-pty` dependency) so non-PTY supervisor
 * paths — `process` / `process-stream-json` / `tmux` on Windows etc. — can
 * import the helper without forcing the native PTY module to load at startup
 * (Codex P1 on PR #149).
 */

// Constructed at module load so the source file contains no literal control
// chars (biome's `noControlCharactersInRegex` lint would otherwise fire on the
// intentional NUL/BS/DEL/etc. class).
const _ptyControlCharStrip = new RegExp("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]", "g");

/**
 * Strip control characters from a prompt string before writing to a PTY.
 *
 * - Embedded `\r` / `\n` are replaced with spaces. claude's TUI submits on
 *   any `\r` and treats `\n` similarly, so an embedded newline would submit
 *   the prompt mid-line — corrupting the turn or firing a stray submit
 *   before the supervisor's trailing CR.
 * - Other C0 controls + DEL (`\x00-\x08`, `\x0b-\x0c`, `\x0e-\x1f`, `\x7f`)
 *   are removed entirely. NUL terminates C-strings in the underlying FFI
 *   write path; BS / DEL act as inline-edit keystrokes in the TUI; BEL etc.
 *   are noisy. Tab (`\x09`) is preserved.
 * - C1 controls (`\x80-\x9f`, U+0080 to U+009F) are removed too. Some terminals
 *   read them as the 8-bit forms of ESC sequences (CSI is U+009B), so they can act
 *   as escape sequences without an ESC byte.
 */
export function sanitizePtyPromptText(text: string): string {
  return text.replace(/\r\n?|\n/g, " ").replace(_ptyControlCharStrip, "");
}

/** First characters that make the REPL read a prompt as a command rather than text. */
const REPL_COMMAND_LEADERS = new Set(["/", "!", "#", "@"]);

/**
 * Keep a prompt from being taken as a REPL command. The REPL treats a prompt that
 * starts with `/` as a slash command, `!` as a shell command, `#` as a memory note and
 * `@` as a file mention. Callers prepend a clock line today, but nothing enforced it,
 * so a prompt whose first non-space character is one of those gets a single leading
 * space. Not for deliberate command prompts (the one-shot `/compact`).
 */
export function neutralizeLeadingReplCommand(text: string): string {
  const first = text.trimStart()[0];
  return first !== undefined && REPL_COMMAND_LEADERS.has(first) ? ` ${text}` : text;
}
