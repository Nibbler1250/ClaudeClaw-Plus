/**
 * The session transcript as the proof of a PTY turn (#562, rounds 2 and 3).
 *
 * The TUI's screen is a poor witness: a prompt that was never submitted, a repaint of
 * the old conversation and a prompt echoed into the input box all paint the same chrome
 * a running turn does. The transcript (`<config>/projects/<enc-cwd>/<session-id>.jsonl`)
 * is written by the CLI itself, not by the renderer, and the bus path already trusts it
 * (`src/bus/jsonl-tailer.ts`). This module reads it for ONE turn, and its verdict is one
 * of three: still running, finished OK (an answer) or finished FAILED (an error text):
 *
 *   - ACCEPTED: a record appended after the send shows the CLI took this prompt: a
 *     `queue-operation` `enqueue`, or a top-level `user` entry, whose payload IS this
 *     turn's prompt (`promptMatches`: the whole payload, not a substring). Only bytes
 *     appended AFTER the send are read, so an earlier entry (or an earlier identical
 *     prompt) can never satisfy it.
 *   - ANSWER: the text of the FINAL assistant message of that turn, as the print path's
 *     `result` is: the blocks of that one message join as-is. Narration between tool calls
 *     ("Let me look.") is not the answer. A final message with no text (a turn that ends on
 *     a tool-only message) leaves the last message that has text.
 *   - ENDED OK: a message of that turn carries a terminal `stop_reason`
 *     (`isTerminalStopReason`, the bus's own rule), or the CLI wrote `turn_duration`.
 *   - ENDED FAILED: the CLI wrote an API-error line (`isApiErrorMessage` / `error`), a
 *     `local-command-stderr`, or something that makes the attribution uncertain (a second
 *     identical prompt, another prompt inside the turn). A failed turn has no answer.
 *   - NOT EVIDENCE: a non-error `<synthetic>` placeholder ("No response requested.") is
 *     written BEFORE the real reply starts. It is neither text nor an end (the bus
 *     tailer makes the same distinction).
 *   - `/compact`: matched by its `<command-name>` user entry; ended by the
 *     `compact_boundary` system entry (or the `local_command` entry carrying its error).
 *
 * A turn is a WINDOW in the file: it opens at the matched `user` entry and closes at the
 * first entry that is not part of it. Once the final message is out, only the remaining
 * lines of that SAME message can still extend the answer; a later prompt (and whatever
 * answers it) is never read into this turn, whichever poll it arrives in.
 *
 * The file must stay the file `mark()` saw: a cut-short, replaced or removed transcript
 * fails the turn (`TranscriptReplacedError`) instead of re-reading retained history as
 * new evidence.
 *
 * Correlation: the matched entry's `uuid` / `promptId` identify "the same record", so a
 * line the CLI repeats is not mistaken for a second prompt. The `parentUuid` chain is NOT
 * used to attribute assistant lines: any other prompt inside the window already fails the
 * turn, and rejecting an unrecognised parent would turn a chain shape this code has not
 * seen into a hang.
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
 * cannot be known: no session id, or an untrusted one-shot (`--no-session-persistence`).
 * There is no switch to turn this off: without a transcript a turn cannot succeed.
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

/** The CLI's own wrapper around a pasted prompt: `<pasted_content id="..">..</pasted_content id="..">`. */
const PASTE_TAGS = /<\/?pasted_content\b[^>]*>/g;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What the transcript records of a user entry, without the CLI's paste wrapper. */
function unwrapPayload(text: string): string {
  return text.normalize("NFC").replace(PASTE_TAGS, "").trim();
}

/** The `<command-name>` of a slash command the CLI recorded, or null. */
function commandNameOf(text: string): string | null {
  return /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1] ?? null;
}

/**
 * Whether the transcript's `entryText` IS the prompt we wrote: the whole payload, after the
 * CLI's paste wrapper and the whitespace around it are taken off, compared for equality.
 * Not containment and not whitespace-insensitive: `check status` is not `hourly check
 * status and restart failures`, and `a b` is not `ab`.
 *
 * The one disagreement between the wire and the transcript is a TAB. `sanitizePtyPromptText`
 * keeps it, but the TUI takes a typed 0x09 as a completion key (recorded as nothing) and a
 * pasted one as spaces (#362, #239). So a TAB in `written` may be recorded as nothing or as
 * a run of spaces, at that position only; every other character must be there as written.
 * An empty write matches nothing.
 */
export function promptMatches(entryText: string, written: string, replCommand: boolean): boolean {
  if (replCommand) {
    const name = commandNameOf(entryText);
    return name !== null && name === written.trim().split(/\s+/)[0];
  }
  const want = written.normalize("NFC").trim();
  if (want === "") return false;
  const got = unwrapPayload(entryText);
  if (got === want) return true;
  if (!want.includes("\t")) return false;
  const tabbed = new RegExp(`^${want.split("\t").map(escapeRegExp).join(" *")}$`, "u");
  return tabbed.test(got);
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

const hasStderrTag = (text: string): boolean => text.includes("<local-command-stderr>");

/** Why a finished turn is NOT a success. */
export type TurnFailureKind = "api-error" | "command-error" | "ambiguous";

export interface TurnFailure {
  kind: TurnFailureKind;
  /** The CLI's own error text, or (ambiguous) what made the attribution uncertain. */
  text: string;
}

export interface TranscriptTurnState {
  /** The CLI took this prompt: an `enqueue` or the `user` entry for it was appended. */
  accepted: boolean;
  /** The turn is over, successfully or not (`failure` says which). */
  ended: boolean;
  /** Set when the turn ended in failure. A failed turn has no answer to return. */
  failure: TurnFailure | null;
  /** The final assistant message's text (the last one that has any); `/compact`'s result for a command. */
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

/**
 * The transcript was cut short, replaced or removed after `mark()`. What is in the file
 * now may be a copy of history this turn already ruled out, so it is not read: the turn
 * fails (and the prompt may have run, so the caller must not resubmit).
 */
export class TranscriptReplacedError extends Error {
  constructor(
    public readonly path: string,
    public readonly why: string,
  ) {
    super(`session transcript ${path} ${why} during the turn`);
    this.name = "TranscriptReplacedError";
  }
}

/** A file's identity: the same path with a different one is a different file. */
interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

/** Where the turn's window is. `terminal` = the final message was seen; `closed` = done. */
type Phase = "seeking" | "open" | "terminal" | "closed";

export class TranscriptTurn {
  private readonly path: string;
  private readonly written: string;
  private readonly replCommand: boolean;
  private offset = 0;
  private carry: Buffer = Buffer.alloc(0);
  private identity: FileIdentity | null = null;
  private phase: Phase = "seeking";
  private enqueued = false;
  private ended = false;
  private failure: TurnFailure | null = null;
  private foreign = 0;
  private toolLines: string[] = [];
  /** This turn's assistant messages in order; the blocks of one message share an id. */
  private messages: Array<{ id: string | undefined; text: string }> = [];
  private finalMessageId: string | undefined;
  private matchedUuid: string | undefined;
  private matchedPromptId: string | undefined;
  private commandResult = "";

  constructor(opts: TranscriptTurnOptions) {
    this.path = opts.path;
    this.written = opts.written;
    this.replCommand = opts.replCommand === true;
  }

  /** Call BEFORE the prompt is written: only what is appended after this counts. */
  mark(): void {
    const stat = this.stat();
    this.identity = stat ? { dev: stat.dev, ino: stat.ino } : null;
    this.offset = stat ? Number(stat.size) : 0;
    this.carry = Buffer.alloc(0);
  }

  /**
   * Read what was appended since the last poll and fold it into the turn state. A turn that
   * has closed reads nothing more. Throws `TranscriptReplacedError` when the file is no
   * longer the one `mark()` saw.
   */
  poll(): TranscriptTurnState {
    if (this.phase === "closed") return this.state();
    const stat = this.stat();
    if (this.identity !== null) {
      if (stat === null) throw new TranscriptReplacedError(this.path, "was removed");
      if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) {
        throw new TranscriptReplacedError(this.path, "was replaced by a different file");
      }
      if (Number(stat.size) < this.offset) {
        throw new TranscriptReplacedError(this.path, "was cut short");
      }
    } else if (stat !== null) {
      // Absent at mark(): the CLI created it since, so everything in it is new.
      this.identity = { dev: stat.dev, ino: stat.ino };
    }
    const size = stat ? Number(stat.size) : 0;
    if (size > this.offset) this.ingestBytes(this.readFrom(this.offset, size));
    return this.state();
  }

  state(): TranscriptTurnState {
    return {
      accepted: this.enqueued || this.phase !== "seeking",
      ended: this.ended,
      failure: this.failure,
      answer: this.failure ? "" : this.replCommand ? this.commandResult : this.answerText(),
      foreignUserEntries: this.foreign,
      toolLines: this.toolLines,
    };
  }

  /**
   * The last message of the window that has text. `messages` only ever holds messages with
   * text, so a final message that has none (tool-only) leaves the one before it.
   */
  private answerText(): string {
    return this.messages[this.messages.length - 1]?.text ?? "";
  }

  private stat(): { dev: bigint; ino: bigint; size: bigint } | null {
    try {
      return statSync(this.path, { bigint: true });
    } catch {
      return null;
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
      // A closed window reads nothing further: whatever follows belongs to another turn.
      if (this.phase === "closed") {
        this.carry = Buffer.alloc(0);
        return;
      }
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
    switch (this.phase) {
      case "seeking":
        this.ingestSeeking(entry);
        return;
      case "open":
        this.ingestOpen(entry);
        return;
      case "terminal":
        this.ingestTerminal(entry);
        return;
      case "closed":
        return;
    }
  }

  /** Before the matched prompt: look for it. Nothing else here is this turn's. */
  private ingestSeeking(entry: Record<string, unknown>): void {
    if (entry.type === "queue-operation") {
      if (
        !this.enqueued &&
        entry.operation === "enqueue" &&
        typeof entry.content === "string" &&
        promptMatches(entry.content, this.written, this.replCommand)
      ) {
        this.enqueued = true;
      }
      return;
    }
    if (entry.type !== "user" || entry.isCompactSummary === true) return;
    const text = userText((entry.message as { content?: unknown } | undefined)?.content);
    if (text === null) return;
    if (promptMatches(text, this.written, this.replCommand)) {
      this.phase = "open";
      this.matchedUuid = typeof entry.uuid === "string" ? entry.uuid : undefined;
      this.matchedPromptId = typeof entry.promptId === "string" ? entry.promptId : undefined;
    } else {
      this.foreign++;
    }
  }

  /** Inside the turn: its assistant lines count; anything else that is not the turn's fails or ends it. */
  private ingestOpen(entry: Record<string, unknown>): void {
    switch (entry.type) {
      case "user":
        this.ingestUserInTurn(entry);
        return;
      case "assistant":
        if (!this.replCommand) this.ingestAssistant(entry);
        return;
      case "system":
        this.ingestSystem(entry);
        return;
    }
  }

  private ingestUserInTurn(entry: Record<string, unknown>): void {
    if (entry.isCompactSummary === true || entry.isMeta === true) return;
    const text = userText((entry.message as { content?: unknown } | undefined)?.content);
    if (text === null) return; // a tool result: the turn's own
    if (hasStderrTag(text)) {
      this.fail("command-error", stripCommandTags(text));
      return;
    }
    // A command's own output is recorded as a user entry too; it is not a prompt.
    if (text.includes("<local-command-stdout>") || this.isSameRecord(entry)) return;
    // Another prompt inside this turn (or this one a second time): whose answer is this?
    this.fail(
      "ambiguous",
      promptMatches(text, this.written, this.replCommand)
        ? "the same prompt was recorded a second time inside the turn"
        : "another prompt was recorded inside the turn",
    );
  }

  /** Whether `entry` is the very record we matched (the CLI can repeat a line). */
  private isSameRecord(entry: Record<string, unknown>): boolean {
    if (this.matchedUuid !== undefined && entry.uuid === this.matchedUuid) return true;
    return this.matchedPromptId !== undefined && entry.promptId === this.matchedPromptId;
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
    if (entry.isApiErrorMessage === true || Boolean(entry.error)) {
      // The CLI writes its own error lines as synthetic assistant messages: the turn is
      // over, and it did not produce a reply (the bus publishes it as `system.api_error`).
      this.fail("api-error", text !== "" ? text : String(entry.error));
      return;
    }
    // A placeholder ("No response requested.") is written BEFORE the real reply starts:
    // neither text nor an end.
    if (message.model === SYNTHETIC_MODEL) return;
    this.addAssistantLine(message.id, text, blocks);
    if (isTerminalStopReason(message.stop_reason)) {
      this.phase = "terminal";
      this.finalMessageId = message.id;
      // The reply is committed once it has text. A final line with none yet (the CLI
      // writes a thinking block as its own line) waits for the rest of its message.
      if (text !== "") this.ended = true;
    }
  }

  private addAssistantLine(
    id: string | undefined,
    text: string,
    blocks: Array<{ type?: string; name?: string; input?: unknown }>,
  ): void {
    for (const b of blocks) {
      if (b?.type === "tool_use" && typeof b.name === "string") {
        const input = JSON.stringify(b.input ?? {});
        this.toolLines.push(
          `● ${b.name}(${input.length > 120 ? `${input.slice(0, 120)}…` : input})`,
        );
      }
    }
    if (text === "") return;
    // Each content block is its own line; blocks of one message share its id and belong
    // together. A different id is a later message of the same turn.
    const last = this.messages[this.messages.length - 1];
    if (last && id !== undefined && last.id === id) last.text += text;
    else this.messages.push({ id, text });
  }

  /**
   * The final message has been seen. Only its own remaining lines can still extend the
   * answer; the first entry that is anything else closes the window. A user entry that is
   * this prompt a second time means the CLI took it twice: not a success.
   */
  private ingestTerminal(entry: Record<string, unknown>): void {
    if (entry.type === "assistant" && !this.replCommand) {
      const message = entry.message as { id?: string; model?: string } | undefined;
      if (
        message?.model !== SYNTHETIC_MODEL &&
        entry.isApiErrorMessage !== true &&
        !entry.error &&
        message?.id === this.finalMessageId
      ) {
        this.ingestAssistant(entry);
        return;
      }
    }
    if (entry.type === "user" && entry.isMeta !== true && entry.isCompactSummary !== true) {
      const text = userText((entry.message as { content?: unknown } | undefined)?.content);
      if (
        text !== null &&
        !this.isSameRecord(entry) &&
        promptMatches(text, this.written, this.replCommand)
      ) {
        this.fail("ambiguous", "the same prompt was recorded a second time after the reply");
        return;
      }
    }
    this.finish();
  }

  private ingestSystem(entry: Record<string, unknown>): void {
    const subtype = entry.subtype;
    const content = typeof entry.content === "string" ? entry.content : "";
    if (hasStderrTag(content)) {
      this.fail("command-error", stripCommandTags(content));
      return;
    }
    if (this.replCommand) {
      if (subtype === "compact_boundary" || subtype === "local_command") {
        const result = stripCommandTags(content);
        if (result !== "" || subtype === "compact_boundary") this.commandResult = result;
        this.finish();
      }
      return;
    }
    if (subtype === "turn_duration") this.finish();
  }

  private finish(): void {
    this.ended = true;
    this.phase = "closed";
  }

  private fail(kind: TurnFailureKind, text: string): void {
    this.failure = { kind, text };
    this.ended = true;
    this.phase = "closed";
  }
}
