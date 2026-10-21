/**
 * The session transcript as the proof of a PTY turn (#562, round 2).
 *
 * The TUI's screen is a poor witness: a prompt that was never submitted, a repaint of
 * the old conversation and a prompt echoed into the input box all paint the same chrome
 * a running turn does. The transcript (`<config>/projects/<enc-cwd>/<session-id>.jsonl`)
 * is written by the CLI itself, not by the renderer, and the bus path already trusts it
 * (`src/bus/jsonl-tailer.ts`). This module reads it for ONE turn:
 *
 *   - ACCEPTED: a record appended after the send shows the CLI took this prompt: a
 *     `queue-operation` `enqueue`, or a top-level `user` entry, whose text is this turn's
 *     prompt. Only bytes appended AFTER the send are read, so an earlier entry (or an
 *     earlier identical prompt) can never satisfy it.
 *   - ANSWER: the text of the last assistant message appended after that `user` entry.
 *   - ENDED: that turn's final assistant message carries a terminal `stop_reason`
 *     (`isTerminalStopReason`, the bus's own rule), or the CLI wrote `turn_duration`.
 *   - `/compact`: matched by its `<command-name>` user entry; ended by the
 *     `compact_boundary` system entry (or the `local_command` entry carrying its error).
 *
 * Pure apart from reading one file; no bus, no PTY. Callers poll.
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeCwdForProjectsDir } from "../bus/jsonl-line-types";
import { isTerminalStopReason } from "../bus/jsonl-tailer";

/** Cap on bytes read per poll, so one huge append cannot stall the event loop. */
const MAX_READ_PER_POLL = 4 * 1024 * 1024;

/** `message.model` on assistant lines the CLI writes itself (API errors, placeholders). */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Where the CLI writes the transcript of `sessionId` run in `cwd`, or null when it
 * cannot be known: no session id (an untrusted one-shot runs `--no-session-persistence`),
 * or the operator turned transcript confirmation off with `CLAUDECLAW_PTY_TRANSCRIPT=0`.
 *
 * The cwd is realpath'd because the CLI encodes the physical directory it was started in
 * (`/tmp` is `/private/tmp` on macOS), as the bus's session manager does.
 */
export function resolveTranscriptPath(opts: {
  cwd: string;
  sessionId: string;
  env: Record<string, string | undefined>;
  untrusted?: boolean;
}): string | null {
  if (opts.untrusted || !opts.sessionId) return null;
  if (process.env.CLAUDECLAW_PTY_TRANSCRIPT === "0") return null;
  const configDir = opts.env.CLAUDE_CONFIG_DIR || join(opts.env.HOME || homedir(), ".claude");
  let physicalCwd = opts.cwd;
  try {
    physicalCwd = realpathSync(opts.cwd);
  } catch {
    // The CLI would have failed to start in a missing directory; keep the logical path.
  }
  return join(
    configDir,
    "projects",
    encodeCwdForProjectsDir(physicalCwd),
    `${opts.sessionId}.jsonl`,
  );
}

/** Whitespace-insensitive form used to compare a transcript prompt with what we wrote. */
function normalise(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** The `<command-name>` of a slash command the CLI recorded, or null. */
function commandNameOf(text: string): string | null {
  return /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1] ?? null;
}

/**
 * Whether the transcript's `text` is the prompt we wrote. A top-level prompt may arrive
 * wrapped (a paste wrapper, a prefix), so containment counts; an empty write matches
 * nothing (it would match everything).
 */
export function promptMatches(entryText: string, written: string, replCommand: boolean): boolean {
  const want = normalise(written);
  if (replCommand) {
    const name = commandNameOf(entryText);
    return name !== null && name === want.split(" ")[0];
  }
  if (want === "") return false;
  return normalise(entryText).includes(want);
}

/** The text of a top-level user entry, or null for tool results and other array content. */
function userText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const blocks = content as Array<{ type?: string; text?: unknown }>;
  if (blocks.some((b) => b?.type === "tool_result")) return null;
  const texts = blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
  return texts.length > 0 ? texts.join("\n") : null;
}

/** `<local-command-stdout>x</local-command-stdout>` → `x`. */
function stripCommandTags(text: string): string {
  return text.replace(/<\/?local-command-(?:stdout|stderr)>/g, "").trim();
}

export interface TranscriptTurnState {
  /** The CLI took this prompt: an `enqueue` or the `user` entry for it was appended. */
  accepted: boolean;
  /** The turn's final reply (or `/compact`'s outcome) is in the transcript. */
  ended: boolean;
  /** Text of the last assistant message with text; `/compact`'s result for a command. */
  answer: string;
  /** Top-level user entries appended after the send that were NOT this prompt. */
  foreignUserEntries: number;
  /** One line per tool call the assistant made this turn, in order (`● Name(input)`). */
  toolLines: readonly string[];
}

export interface TranscriptTurnOptions {
  path: string;
  /** Exactly what was written to the PTY (after sanitising / neutralising). */
  written: string;
  /** The turn is a deliberate `/compact`. */
  replCommand?: boolean;
}

export class TranscriptTurn {
  private readonly path: string;
  private readonly written: string;
  private readonly replCommand: boolean;
  private offset = 0;
  private carry: Buffer = Buffer.alloc(0);
  private enqueued = false;
  private userMatched = false;
  private ended = false;
  private foreign = 0;
  private toolLines: string[] = [];
  private messageId: string | undefined;
  private messageText = "";
  private commandResult = "";

  constructor(opts: TranscriptTurnOptions) {
    this.path = opts.path;
    this.written = opts.written;
    this.replCommand = opts.replCommand === true;
  }

  /** Call BEFORE the prompt is written: only what is appended after this counts. */
  mark(): void {
    this.offset = this.size();
    this.carry = Buffer.alloc(0);
  }

  /** Read what was appended since the last poll and fold it into the turn state. */
  poll(): TranscriptTurnState {
    const size = this.size();
    if (size < this.offset) {
      // Cut short or replaced: nothing we saw is still there. Start over from the top.
      this.offset = 0;
      this.carry = Buffer.alloc(0);
    }
    if (size > this.offset) this.ingestBytes(this.readFrom(this.offset, size));
    return this.state();
  }

  state(): TranscriptTurnState {
    return {
      accepted: this.enqueued || this.userMatched,
      ended: this.ended,
      answer: this.replCommand ? this.commandResult : this.messageText,
      foreignUserEntries: this.foreign,
      toolLines: this.toolLines,
    };
  }

  private size(): number {
    try {
      return statSync(this.path).size;
    } catch {
      return 0;
    }
  }

  private readFrom(from: number, to: number): Buffer {
    const want = Math.min(to - from, MAX_READ_PER_POLL);
    const buf = Buffer.alloc(want);
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return Buffer.alloc(0);
    }
    try {
      const n = readSync(fd, buf, 0, want, from);
      return buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  }

  private ingestBytes(bytes: Buffer): void {
    this.offset += bytes.length;
    let data = this.carry.length === 0 ? bytes : Buffer.concat([this.carry, bytes]);
    for (;;) {
      const nl = data.indexOf(0x0a);
      if (nl < 0) break;
      const line = data.subarray(0, nl).toString("utf8").trim();
      data = data.subarray(nl + 1);
      if (line === "") continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // A torn or foreign line is not evidence of anything.
      }
      if (entry && typeof entry === "object") this.ingest(entry as Record<string, unknown>);
    }
    this.carry = Buffer.from(data);
  }

  private ingest(entry: Record<string, unknown>): void {
    if (entry.isSidechain === true) return; // a sub-agent's, not this session's turn
    switch (entry.type) {
      case "queue-operation":
        if (
          !this.enqueued &&
          entry.operation === "enqueue" &&
          typeof entry.content === "string" &&
          promptMatches(entry.content, this.written, this.replCommand)
        ) {
          this.enqueued = true;
        }
        return;
      case "user":
        this.ingestUser(entry);
        return;
      case "assistant":
        if (this.userMatched && !this.replCommand) this.ingestAssistant(entry);
        return;
      case "system":
        if (this.userMatched) this.ingestSystem(entry);
        return;
    }
  }

  private ingestUser(entry: Record<string, unknown>): void {
    if (this.userMatched || entry.isCompactSummary === true) return;
    const text = userText((entry.message as { content?: unknown } | undefined)?.content);
    if (text === null) return;
    if (promptMatches(text, this.written, this.replCommand)) this.userMatched = true;
    else this.foreign++;
  }

  private ingestAssistant(entry: Record<string, unknown>): void {
    const message = entry.message as
      | { id?: string; model?: string; content?: unknown; stop_reason?: unknown }
      | undefined;
    if (!message) return;
    const blocks = Array.isArray(message.content)
      ? (message.content as Array<{ type?: string; text?: unknown }>)
      : [];
    const text = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    for (const b of blocks as Array<{ type?: string; name?: string; input?: unknown }>) {
      if (b?.type === "tool_use" && typeof b.name === "string") {
        const input = JSON.stringify(b.input ?? {});
        this.toolLines.push(
          `● ${b.name}(${input.length > 120 ? `${input.slice(0, 120)}…` : input})`,
        );
      }
    }
    if (text !== "") {
      // Each content block is its own line; blocks of one message share its id and
      // belong together. A different id is a later message, and the later one wins.
      if (message.id !== undefined && message.id === this.messageId) this.messageText += text;
      else this.messageText = text;
      this.messageId = message.id;
    }
    // The CLI writes its own error lines (API errors) as synthetic assistant messages:
    // a boundary of the turn, not a model reply to wait past.
    if (
      entry.isApiErrorMessage === true ||
      message.model === SYNTHETIC_MODEL ||
      isTerminalStopReason(message.stop_reason)
    ) {
      this.ended = true;
    }
  }

  private ingestSystem(entry: Record<string, unknown>): void {
    const subtype = entry.subtype;
    if (this.replCommand) {
      if (subtype === "compact_boundary" || subtype === "local_command") {
        const content = typeof entry.content === "string" ? stripCommandTags(entry.content) : "";
        if (content !== "" || subtype === "compact_boundary") this.commandResult = content;
        this.ended = true;
      }
      return;
    }
    if (subtype === "turn_duration") this.ended = true;
  }
}
