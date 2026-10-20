/**
 * The upstream no-reply hang, as the integration spike sees it (#570 r15b): the turn timed out
 * (exit 124, reason `timeout`), the prompt reached the transcript, and claude wrote neither an
 * assistant entry nor an API error. Production retries this once; the spike's CONTROL PRESENT rows
 * do the same. Any other failure is a result, not a hang.
 */
export interface HangObservation {
  exitCode: number;
  reason: string | undefined;
  promptSeen: boolean;
  assistantEntries: number;
  apiErrors: number;
}

export function isHangSignature(seen: HangObservation): boolean {
  return (
    seen.exitCode === 124 &&
    seen.reason === "timeout" &&
    seen.promptSeen &&
    seen.assistantEntries === 0 &&
    seen.apiErrors === 0
  );
}

/** The log line for a retry: a fixed vocabulary, with only the row's own label in it. */
export function rowRetryLine(rowLabel: string): string {
  return `[isolation-spike] row-retry ${rowLabel}: reason=hang-signature`;
}
