/**
 * Session quarantine (#562 round 8).
 *
 * A process whose exit the OS did not confirm after SIGKILL may still append to its
 * transcript, so no other claude may start on that session until a later confirmation
 * succeeds. The registry is keyed by SESSION (the supervisor key AND the claude session
 * id), not by whether an entry is still in the supervisor's map: the retained process of a
 * failed crash recovery, a retired entry and a one-shot `--resume` of the same transcript
 * all meet the same record.
 *
 * `assertSessionWritable` is the ONE gate. Every path that can start a claude on a session
 * passes it: PTY spawn and respawn, `sendToLiveSession`, the one-shot engine, the legacy
 * `claude -p --resume`. It also retries the confirmation, so a quarantine does not need a
 * timer to be released: the next use of the session does it.
 */
import type { PtyProcess } from "./pty-process.js";

/** Thrown while a process on the session has not been proven dead. */
export class PtyQuarantinedError extends Error {
  constructor(session: string) {
    super(
      `[pty-supervisor] ${session} is quarantined: its previous process is still alive after SIGKILL, so nothing is spawned or resumed on the session until the OS confirms it gone`,
    );
    this.name = "PtyQuarantinedError";
  }
}

/** What identifies a session to the gate: either id matches a record. */
export interface SessionTarget {
  /** Supervisor key (`global`, `agent:<name>`, `thread:<id>`, `fallback:<key>`). */
  sessionKey?: string;
  /** Claude session id (the transcript). */
  sessionId?: string;
}

export interface QuarantineInfo {
  sessionKey: string;
  sessionId: string;
  pid: number;
  /** Short fixed code, safe to show in a status listing. */
  reason: string;
  /** Wall-clock ms when the session entered quarantine. */
  since: number;
}

interface QuarantineRecord {
  sessionKey: string;
  pty: PtyProcess;
  reason: string;
  since: number;
}

let records: QuarantineRecord[] = [];

/** Put a session under quarantine. Logs once per process (pids belong in the daemon log). */
export function quarantineSession(sessionKey: string, pty: PtyProcess, reason: string): void {
  if (records.some((r) => r.pty === pty)) return;
  records.push({ sessionKey, pty, reason, since: Date.now() });
  console.warn(
    `[pty-supervisor] session ${sessionKey} quarantined (${reason}): pid ${pty.pid} not confirmed gone after SIGKILL; nothing starts on it until the OS confirms the exit`,
  );
}

function matches(r: QuarantineRecord, t: SessionTarget): boolean {
  if (t.sessionKey !== undefined && r.sessionKey === t.sessionKey) return true;
  const id = r.pty.sessionId;
  return Boolean(t.sessionId) && Boolean(id) && id === t.sessionId;
}

/** True while a process on the session is not proven dead. Synchronous: no retry. */
export function isSessionQuarantined(target: SessionTarget): boolean {
  return records.some((r) => matches(r, target));
}

async function tryRelease(r: QuarantineRecord): Promise<void> {
  try {
    await (r.pty.confirmExit ? r.pty.confirmExit() : r.pty.dispose());
  } catch {
    return;
  }
  records = records.filter((x) => x !== r);
}

/**
 * The gate. Resolves when no process is quarantined on the session, after asking each one
 * that is to prove its exit again (identity-checked, see `PtyProcessImpl`). Throws
 * `PtyQuarantinedError` while one still lives.
 */
export async function assertSessionWritable(target: SessionTarget): Promise<void> {
  const hits = records.filter((r) => matches(r, target));
  if (hits.length === 0) return;
  await Promise.all(hits.map(tryRelease));
  if (records.some((r) => matches(r, target))) {
    throw new PtyQuarantinedError(target.sessionKey ?? target.sessionId ?? "session");
  }
}

/** Re-ask every quarantined process to prove its exit; returns how many are still alive. */
export async function confirmAllQuarantined(): Promise<number> {
  await Promise.all([...records].map(tryRelease));
  return records.length;
}

/** The quarantined sessions, for status. Sorted by key. */
export function quarantineSnapshot(): QuarantineInfo[] {
  return records
    .map((r) => ({
      sessionKey: r.sessionKey,
      sessionId: r.pty.sessionId,
      pid: r.pty.pid,
      reason: r.reason,
      since: r.since,
    }))
    .sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}

/** Keys of the quarantined sessions (unique). */
export function quarantinedKeys(): string[] {
  return [...new Set(records.map((r) => r.sessionKey))];
}

/** For tests only. */
export function __resetQuarantineForTests(): void {
  records = [];
}
