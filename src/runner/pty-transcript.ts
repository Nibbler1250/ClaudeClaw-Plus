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
 *     (`isTerminalStopReason`, the bus's own rule) AND the transcript then shows that message
 *     is over: the CLI's `turn_duration`, or the next entry that is not another line of that
 *     message (a different message id, a `user` entry, any other record), or no new bytes for
 *     `TRANSCRIPT_SETTLE_MS`. One definition, from the transcript alone: whether the final
 *     message has text does not matter (a thinking-only or tool-only final message ends the
 *     turn the same way; the answer is then the last message that has text, or empty), and
 *     the screen never decides how many blocks of it belong to the answer.
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
 * lines of that SAME message can still extend the answer, and the window closing is what
 * ENDS the turn; a later prompt (and whatever answers it) is never read into this turn,
 * whichever poll it arrives in.
 *
 * Unresolved submissions: a turn that ends in ANY non-ok outcome (not accepted, timed out,
 * failed, ambiguous, transcript replaced, process closed) may still have run, its record
 * arriving late. Its prompt is remembered for this transcript file (`unresolved`), and a
 * later submission of the identical payload fails as ambiguous while that one is
 * unresolved: the record that arrives could be either's. It is resolved when its own
 * record and its turn's end are in the file, or after `UNRESOLVED_TTL_MS`, or when the
 * file is another one (the session rotated or reset). The transcript offers no per-submission
 * id we could correlate: `uuid` / `promptId` are assigned by the CLI after the submit.
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
import { createHash } from "node:crypto";
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
 * With a terminal `stop_reason` seen and no `turn_duration` or other record after it, the
 * turn ends once the file has not grown for this long. Transcript timing, not screen timing.
 * The CLI writes the lines of one message back to back (milliseconds apart), and every real
 * capture (docs/spikes fixtures) has `turn_duration` right after the final line, so this is
 * only the backstop for a CLI that writes neither: long enough to outlast the gap between
 * two blocks of a message, short enough (<= 2 s) that the hard timeout never decides.
 */
export const TRANSCRIPT_SETTLE_MS = 1500;

/** How long an unresolved earlier submission can still contaminate a later identical one. */
export const UNRESOLVED_TTL_MS = 120_000;

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

/**
 * The CLI's own wrapper around a pasted prompt, when it is the WHOLE payload:
 * `<pasted_content id="..">..</pasted_content id="..">`. Only this outer wrapper is taken
 * off; a literal tag inside the text is the prompt's own.
 */
const OUTER_PASTE_WRAPPER = /^<pasted_content\b[^>]*>([\s\S]*)<\/pasted_content\b[^>]*>$/;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What the transcript may have recorded of a user entry: the payload as is, then without an outer paste wrapper. */
function payloadForms(text: string): string[] {
  const raw = text.normalize("NFC").trim();
  const inner = OUTER_PASTE_WRAPPER.exec(raw)?.[1]?.trim();
  return inner === undefined ? [raw] : [raw, inner];
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
  const tabbed = want.includes("\t")
    ? new RegExp(`^${want.split("\t").map(escapeRegExp).join(" *")}$`, "u")
    : null;
  // The payload as recorded comes first: a prompt that itself contains paste tags matches
  // as it is, and only a recognised OUTER wrapper is looked through.
  return payloadForms(entryText).some((got) => got === want || tabbed?.test(got) === true);
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
  /** Clock (ms) for the transcript-side settle and the unresolved TTL. Defaults to `Date.now`. */
  now?: () => number;
  /** Override `TRANSCRIPT_SETTLE_MS`. */
  settleMs?: number;
  /** Internal: read from this offset without `mark()`, ignoring the unresolved registry (a probe). */
  probeFromOffset?: number;
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

/** A submission whose outcome is not known: it may have run, its record arriving late. */
interface UnresolvedPrompt {
  written: string;
  replCommand: boolean;
  /** Where the transcript ended when that turn was marked: its record can only be after this. */
  offset: number;
  identity: FileIdentity | null;
  at: number;
}

/** Per transcript file, keyed by the normalised payload's hash. Small: one entry per stuck prompt. */
const unresolved = new Map<string, Map<string, UnresolvedPrompt>>();
const MAX_UNRESOLVED_PER_FILE = 8;

const payloadKey = (written: string, replCommand: boolean): string =>
  createHash("sha256")
    .update(replCommand ? `cmd:${written.trim().split(/\s+/)[0]}` : written.normalize("NFC").trim())
    .digest("hex");

/** Test hook: forget every unresolved submission. */
export function resetUnresolvedPrompts(): void {
  unresolved.clear();
}

/**
 * Drop the unresolved submissions of `path` that are over (resolved, expired, or of another
 * file), and return the keys of those still open at this instant.
 */
function openUnresolvedKeys(path: string, now: number): Set<string> {
  const entries = unresolved.get(path);
  if (!entries) return new Set();
  let stat: { dev: bigint; ino: bigint; size: bigint } | null = null;
  try {
    stat = statSync(path, { bigint: true });
  } catch {
    // no file: nothing in it can resolve or contaminate anything
  }
  for (const [key, e] of entries) {
    // No file yet is not "another file": the late record may be what creates it.
    const otherFile =
      stat !== null &&
      ((e.identity !== null && (stat.dev !== e.identity.dev || stat.ino !== e.identity.ino)) ||
        Number(stat.size) < e.offset);
    const over =
      otherFile ||
      now - e.at >= UNRESOLVED_TTL_MS ||
      (stat !== null && submissionResolved(path, e));
    if (over) entries.delete(key);
  }
  if (entries.size === 0) unresolved.delete(path);
  return new Set(entries.keys());
}

/** Its own record AND its turn's end are in the file already (so they cannot arrive late). */
function submissionResolved(path: string, e: UnresolvedPrompt): boolean {
  const probe = new TranscriptTurn({
    path,
    written: e.written,
    replCommand: e.replCommand,
    probeFromOffset: e.offset,
  });
  for (let i = 0; i < 64; i++) {
    const before = probe.readOffset();
    probe.poll();
    if (probe.readOffset() === before) break;
  }
  const s = probe.state();
  return s.ended && s.failure?.kind !== "ambiguous";
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
  private readonly now: () => number;
  private readonly settleMs: number;
  private readonly probe: boolean;
  /** When the file last grew (as seen by a poll): the transcript-side settle clock. */
  private lastGrowthAt = 0;
  /** Unresolved identical submissions at `mark()`: a match while one is open is ambiguous. */
  private openUnresolved: ReadonlySet<string> = new Set();
  private markedOffset = 0;

  constructor(opts: TranscriptTurnOptions) {
    this.path = opts.path;
    this.written = opts.written;
    this.replCommand = opts.replCommand === true;
    this.now = opts.now ?? Date.now;
    this.settleMs = opts.settleMs ?? TRANSCRIPT_SETTLE_MS;
    this.probe = opts.probeFromOffset !== undefined;
    if (opts.probeFromOffset !== undefined) this.offset = opts.probeFromOffset;
  }

  /** Call BEFORE the prompt is written: only what is appended after this counts. */
  mark(): void {
    const stat = this.stat();
    this.identity = stat ? { dev: stat.dev, ino: stat.ino } : null;
    this.offset = stat ? Number(stat.size) : 0;
    this.markedOffset = this.offset;
    this.carry = Buffer.alloc(0);
    this.openUnresolved = openUnresolvedKeys(this.path, this.now());
  }

  /**
   * This turn ended in a non-ok outcome (or never got one): it may still have run, so a later
   * submission of the identical payload on this file is ambiguous until this one is resolved.
   * The caller says so on every rejection; a turn that ended ok is never passed here.
   */
  abandon(): void {
    if (this.probe) return;
    const entries = unresolved.get(this.path) ?? new Map<string, UnresolvedPrompt>();
    const key = payloadKey(this.written, this.replCommand);
    // The same prompt abandoned again keeps the earliest offset: its record may be anywhere after it.
    const prev = entries.get(key);
    const sameFile = prev !== undefined && prev.identity?.ino === this.identity?.ino;
    entries.delete(key);
    entries.set(key, {
      written: this.written,
      replCommand: this.replCommand,
      offset: sameFile ? Math.min(prev.offset, this.markedOffset) : this.markedOffset,
      identity: this.identity,
      at: this.now(),
    });
    while (entries.size > MAX_UNRESOLVED_PER_FILE) {
      entries.delete(entries.keys().next().value as string);
    }
    unresolved.set(this.path, entries);
  }

  /** How far into the file this turn has read. */
  readOffset(): number {
    return this.offset;
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
    if (size > this.offset) {
      this.lastGrowthAt = this.now();
      this.ingestBytes(this.readFrom(this.offset, size));
    }
    // A terminal message with nothing after it: the file has gone quiet. Transcript time.
    if (this.phase === "terminal" && this.now() - this.lastGrowthAt >= this.settleMs) {
      this.finish();
    }
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
        if (this.hasOpenEarlierSubmission()) this.failEarlierSubmission();
      }
      return;
    }
    if (entry.type !== "user" || entry.isCompactSummary === true) return;
    const text = userText((entry.message as { content?: unknown } | undefined)?.content);
    if (text === null) return;
    if (promptMatches(text, this.written, this.replCommand)) {
      if (this.hasOpenEarlierSubmission()) {
        this.failEarlierSubmission();
        return;
      }
      this.phase = "open";
      this.matchedUuid = typeof entry.uuid === "string" ? entry.uuid : undefined;
      this.matchedPromptId = typeof entry.promptId === "string" ? entry.promptId : undefined;
    } else {
      this.foreign++;
    }
  }

  /** An earlier submission of this identical payload is unresolved: this record could be its. */
  private hasOpenEarlierSubmission(): boolean {
    return this.openUnresolved.has(payloadKey(this.written, this.replCommand));
  }

  private failEarlierSubmission(): void {
    this.fail(
      "ambiguous",
      "an earlier submission of this identical prompt in this session is unresolved: its record may be the one that arrived",
    );
  }

  /** Inside the turn: its assistant lines count; anything else that is not the turn's fails or ends it. */
  private ingestOpen(entry: Record<string, unknown>): void {
    switch (entry.type) {
      case "user":
        this.ingestUserInTurn(entry);
        return;
      case "assistant":
        this.ingestAssistant(entry);
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
    // A command's answer is its own output (`compact_boundary` / `local_command`), so the
    // assistant's ordinary text is not read for it; its error flags above still are.
    if (this.replCommand) return;
    // A placeholder ("No response requested.") is written BEFORE the real reply starts:
    // neither text nor an end.
    if (message.model === SYNTHETIC_MODEL) return;
    this.addAssistantLine(message.id, text, blocks);
    if (isTerminalStopReason(message.stop_reason)) {
      // The final message is out, whether or not it has text (a thinking block is its own
      // line, and a tool-only or empty one has none). The turn ENDS when the transcript shows
      // the message is over (`ingestTerminal`), never on the first line with text.
      this.phase = "terminal";
      this.finalMessageId = message.id;
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
    if (entry.type === "assistant") {
      const message = entry.message as { id?: string; model?: string } | undefined;
      if (
        message?.model !== SYNTHETIC_MODEL &&
        entry.isApiErrorMessage !== true &&
        !entry.error &&
        this.finalMessageId !== undefined &&
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
