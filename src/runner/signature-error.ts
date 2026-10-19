/**
 * Detection of the "Invalid `signature` in `thinking` block" API error, which means the
 * stored session transcript is corrupt and the runner should reset the session.
 *
 * Two hazards shape this file (#562 security review):
 *
 *  1. The text it scans is attacker-influenced (chat content, fetched pages, model
 *     output), and the runner is one JS thread. A pattern of `Invalid.*signature.*
 *     thinking.*block` backtracks super-linearly: about 2.3 s on 200 repeats of
 *     "Invalid signature thinking ". `hasSignatureError` therefore uses `indexOf` with
 *     monotone cursors and never a quantified wildcard, so it is linear.
 *  2. On a PTY the REPL can render the API error and stay up with exit 0, so the text
 *     alone cannot be trusted: a model that quotes a log can end its reply with the
 *     same line. `confirmRenderedSignatureError` additionally requires the session
 *     transcript's last message to be the CLI's own API-error entry
 *     (`isApiErrorMessage`), which the model's text cannot produce.
 */
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { encodeCwdForProjectsDir } from "../bus/jsonl-line-types";

/** The four words must appear in order, on one line, within this many characters. */
const SIGNATURE_SPAN = 600;
const WORDS = ["invalid", "signature", "thinking", "block"] as const;

/**
 * True when "Invalid ... signature ... thinking ... block" appears in order on one line
 * within `SIGNATURE_SPAN` characters (case-insensitive). Linear in `text.length`: the
 * cursors for each word only move forward.
 */
export function hasSignatureError(text: string): boolean {
  const lower = text.toLowerCase();
  const next: number[] = [-2, -2, -2, -2, -2];
  const find = (word: number, from: number): number => {
    const cached = next[word] as number;
    // A cached hit at or after `from` is still the first one; -1 (none left) stays none.
    if (cached === -1 || (cached >= from && cached !== -2)) return cached;
    const hit = lower.indexOf(WORDS[word] as string, from);
    next[word] = hit;
    return hit;
  };
  for (let i = find(0, 0); i !== -1; i = find(0, i + 1)) {
    const s = find(1, i + 7);
    if (s === -1) return false;
    const t = find(2, s + 9);
    if (t === -1) return false;
    const b = find(3, t + 8);
    if (b === -1) return false;
    if (b + 5 - i > SIGNATURE_SPAN) continue;
    // One line: no newline anywhere between the first word and the last.
    if (!lower.slice(i, b + 5).includes("\n")) return true;
  }
  return false;
}

/** Non-empty trailing lines scanned for the rendered error. */
const RENDERED_SIGNATURE_TAIL_LINES = 2;
/** A rendered error line is far shorter than this (the JSON body is a few hundred chars). */
const RENDERED_LINE_MAX = 2000;
const RENDERED_PREFIX = /^\s*API Error:/i;

/**
 * A PTY turn that exits 0 but ENDS in the REPL's rendered `API Error: ... Invalid
 * signature ... thinking block`. Only the tail counts: the error ends the turn, so it is
 * the last thing printed, while an agent that quotes a log keeps talking after it. This
 * is a cheap pre-filter only: model text can still end that way, which is why the
 * runner also calls `confirmRenderedSignatureError`.
 */
export function endsInRenderedSignatureError(output: string): boolean {
  const tail = output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-RENDERED_SIGNATURE_TAIL_LINES);
  return tail.some(
    (line) =>
      line.length <= RENDERED_LINE_MAX && RENDERED_PREFIX.test(line) && hasSignatureError(line),
  );
}

/** Bytes read from the end of the transcript; an API-error entry is well under this. */
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

/** Returns the end of the session transcript, or null when it cannot be read. */
export type TranscriptTailReader = (cwd: string, sessionId: string) => Promise<string | null>;

/** Claude Code names a session by a UUID, and so does every id this repo mints. */
const SESSION_ID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The transcript path for a session, or null when the id is not a UUID. The id comes from
 * CLI output and stored sessions; it is never allowed to carry a path separator or `..`
 * into the path.
 */
export function transcriptPathFor(cwd: string, sessionId: string): string | null {
  if (!SESSION_ID_FORMAT.test(sessionId)) return null;
  return resolvePath(
    homedir(),
    ".claude",
    "projects",
    encodeCwdForProjectsDir(resolvePath(cwd)),
    `${sessionId}.jsonl`,
  );
}

const defaultReadTranscriptTail: TranscriptTailReader = async (cwd, sessionId) => {
  try {
    const path = transcriptPathFor(cwd, sessionId);
    if (!path) return null;
    const { size } = await stat(path);
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const handle = await open(path, "r");
    try {
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

let readTranscriptTail: TranscriptTailReader = defaultReadTranscriptTail;
let sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

/** For tests only. Inject the transcript reader and the retry sleep; null restores both. */
export function injectSignatureConfirmForTests(
  deps: { readTail?: TranscriptTailReader; sleep?: (ms: number) => Promise<void> } | null,
): void {
  readTranscriptTail = deps?.readTail ?? defaultReadTranscriptTail;
  sleep = deps?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
}

interface TranscriptEntry {
  type?: unknown;
  isApiErrorMessage?: unknown;
  message?: { content?: unknown };
}

function entryText(entry: TranscriptEntry): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("\n");
}

/**
 * True when the last message entry in the transcript tail (skipping bookkeeping lines such
 * as `last-prompt`) is an assistant entry the CLI flagged `isApiErrorMessage` whose text is
 * the signature error. Assistant text the model wrote is never flagged.
 */
export function transcriptEndsInSignatureApiError(tail: string): boolean {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] as string).trim();
    if (line === "") continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue; // the first line of a tail read can be cut mid-entry
    }
    // `null`, a number or an array parses fine and is not a transcript entry.
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (entry.type !== "assistant" && entry.type !== "user") continue;
    return (
      entry.type === "assistant" &&
      entry.isApiErrorMessage === true &&
      hasSignatureError(entryText(entry))
    );
  }
  return false;
}

/** The transcript can lag the rendered screen by a moment; ask a few times. */
const CONFIRM_ATTEMPTS = 3;
const CONFIRM_RETRY_MS = 200;

/**
 * Whether a PTY turn that exited 0 really ended in the CLI's signature API error: the
 * rendered tail looks like it AND the session transcript's last message is the CLI's own
 * API-error entry. Without the second check, a model that quotes the error as the last
 * line of a reply would get the shared session wiped.
 */
export async function confirmRenderedSignatureError(args: {
  output: string;
  sessionId: string | undefined;
  cwd: string;
}): Promise<boolean> {
  // Fail closed: anything unexpected means "not confirmed", so no session is reset.
  try {
    if (!endsInRenderedSignatureError(args.output)) return false;
    if (!args.sessionId || args.sessionId === "unknown") return false;
    for (let attempt = 0; attempt < CONFIRM_ATTEMPTS; attempt += 1) {
      const tail = await readTranscriptTail(args.cwd, args.sessionId);
      if (tail !== null && transcriptEndsInSignatureApiError(tail)) return true;
      if (attempt < CONFIRM_ATTEMPTS - 1) await sleep(CONFIRM_RETRY_MS);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Whether a finished turn means the stored session is corrupt and must be reset.
 *
 * - Print (`claude -p`): a non-zero exit whose output has the phrase, as before.
 * - PTY: always the confirmed check (rendered tail AND the transcript's own API-error
 *   entry), whatever the exit code. A PTY turn that quotes the phrase and then times out
 *   (124) or fails would otherwise reset the shared session on text the model wrote.
 */
export async function signatureErrorWarrantsReset(args: {
  useLegacyPath: boolean;
  exitCode: number;
  output: string;
  stderr: string;
  sessionId: string | undefined;
  cwd: string;
}): Promise<boolean> {
  if (args.useLegacyPath) {
    return args.exitCode !== 0 && hasSignatureError(args.output + args.stderr);
  }
  return confirmRenderedSignatureError({
    output: args.output,
    sessionId: args.sessionId,
    cwd: args.cwd,
  });
}
