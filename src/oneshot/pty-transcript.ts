import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Transcript lag behind the rendered screen is milliseconds; this only bounds a stuck turn. */
export const TRANSCRIPT_WAIT_MS = 15_000;
const POLL_MS = 100;
const SETTLE_MS = 300;

interface TranscriptBlock {
  type?: unknown;
  text?: unknown;
}
interface TranscriptEntry {
  type?: unknown;
  isApiErrorMessage?: unknown;
  message?: { id?: unknown; model?: unknown; content?: unknown };
}

function transcriptFiles(projectDir: string): string[] {
  if (!existsSync(projectDir)) return [];
  return readdirSync(projectDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(projectDir, entry.name))
    .sort();
}

/** The model's own text blocks, or undefined for user, synthetic and API-error entries. */
function replyText(entry: TranscriptEntry): string | undefined {
  if (entry.type !== "assistant" || entry.isApiErrorMessage === true) return undefined;
  if (entry.message?.model === "<synthetic>") return undefined;
  if (!Array.isArray(entry.message?.content)) return undefined;
  const text = (entry.message.content as TranscriptBlock[])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
  return text === "" ? undefined : text;
}

/**
 * Text of the last real assistant message in the transcripts under `projectDir`.
 * One API message can span several entries (thinking, then text); entries sharing
 * the last reply's `message.id` are joined. A partial trailing line is skipped.
 * Never throws: an unreadable file simply supplies no evidence.
 */
export function readLastAssistantReply(projectDir: string): string | undefined {
  const replies: Array<{ id: string | undefined; text: string }> = [];
  for (const file of transcriptFiles(projectDir)) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line) as TranscriptEntry;
        const text = replyText(entry);
        if (text === undefined) continue;
        const id = entry.message?.id;
        replies.push({ id: typeof id === "string" ? id : undefined, text });
      } catch {
        /* partial trailing line */
      }
    }
  }
  const last = replies.at(-1);
  if (!last) return undefined;
  if (last.id === undefined) return last.text;
  return replies
    .filter((reply) => reply.id === last.id)
    .map((reply) => reply.text)
    .join("");
}

export interface AwaitReplyOptions {
  waitMs?: number;
  settleMs?: number;
  signal?: AbortSignal;
}

/**
 * Poll for the reply until it appears or `waitMs` passes, then settle briefly and
 * re-read so a text entry written just after the first is not missed. Returns
 * undefined when none appears: the caller must not substitute screen text.
 */
export async function awaitLastAssistantReply(
  projectDir: string,
  options: AwaitReplyOptions = {},
): Promise<string | undefined> {
  const deadline = Date.now() + (options.waitMs ?? TRANSCRIPT_WAIT_MS);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (;;) {
    if (readLastAssistantReply(projectDir) !== undefined) break;
    if (options.signal?.aborted || Date.now() >= deadline) return undefined;
    await sleep(POLL_MS);
  }
  await sleep(options.settleMs ?? SETTLE_MS);
  return readLastAssistantReply(projectDir);
}
