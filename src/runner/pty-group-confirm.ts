/**
 * What a FAILED process-group exit confirmation means for a PTY (#581 cp3, staged enforcement,
 * Terry's ruling of 2026-10-23).
 *
 * Termination is the same for every PTY (`retireProcessGroup`): TERM, then SIGKILL to the proven
 * group. What differs is what an unconfirmed GROUP does once the LEADER is proven gone:
 *   - untrusted one-shots always enforce: the session is quarantined and the root and slot held;
 *   - trusted PTYs follow `pty.groupConfirm`: "observe" (default) logs one line and counts it,
 *     "enforce" quarantines like an unconfirmed leader.
 * An unconfirmed LEADER quarantines in every mode and on every route; this module is never asked
 * about it.
 *
 * `groupConfirmEnforced` is the one predicate. It is read at the one place a group outcome is
 * mapped, so flipping the trusted default later is a one-line change in the settings default.
 */

import { getSettings } from "../config.js";
import type { RetireGroupOutcome, SurvivorCause } from "./pty-group-kill.js";

export type GroupConfirmMode = "observe" | "enforce";

/** The configured mode; "observe" when the settings are not loaded (that is the default). */
export function configuredGroupConfirm(): GroupConfirmMode {
  try {
    return getSettings().pty.groupConfirm === "enforce" ? "enforce" : "observe";
  } catch {
    return "observe";
  }
}

/**
 * Does an unconfirmed group (leader gone) fail the retirement? An untrusted PTY always: the
 * setting cannot weaken it. A trusted one only in "enforce".
 */
export function groupConfirmEnforced(
  untrusted: boolean,
  mode: GroupConfirmMode = configuredGroupConfirm(),
): boolean {
  return untrusted || mode === "enforce";
}

export interface GroupUnconfirmedReport {
  /** The supervisor session key, or the bus agent id. */
  key: string;
  reason: string;
  /** Undefined when the members could not be counted. */
  survivors: number | undefined;
  /** Executable basenames only. */
  comm: readonly string[];
}

export type GroupVerdict = { fatal: false } | { fatal: true; cause: SurvivorCause };

/**
 * THE one place a retirement outcome becomes a verdict, for every adapter (the runner PTY, the
 * bus PTY adapter, the schema probe).
 *   leader not proven gone      fatal, always, on every route and in every mode
 *   leader gone, group not      fatal when `groupConfirmEnforced`; otherwise observed (logged and
 *                               counted, not fatal)
 *   an escapee the scan found   treated as an unconfirmed group (only isolated one-shots scan)
 * A fatal verdict is the adapter's cue to reject with `PtyExitUnconfirmedError`, which is what
 * the supervisor quarantines on.
 */
export function judgeGroupOutcome(
  outcome: RetireGroupOutcome,
  ctx: { untrusted: boolean; mode?: GroupConfirmMode; key: string },
  scanCause: SurvivorCause | null = null,
): GroupVerdict {
  const leaderUnconfirmed = !outcome.leaderGone;
  const groupUnconfirmed = outcome.leaderGone && !outcome.groupGone;
  const cause: SurvivorCause | null = leaderUnconfirmed || groupUnconfirmed ? "group" : scanCause;
  if (cause === null) return { fatal: false };
  if (!leaderUnconfirmed && !groupConfirmEnforced(ctx.untrusted, ctx.mode)) {
    recordGroupUnconfirmedObserved({
      key: ctx.key,
      reason: outcome.reason ?? cause,
      survivors: outcome.survivors,
      comm: outcome.comm,
    });
    return { fatal: false };
  }
  return { fatal: true, cause };
}

let observed = 0;

/** A fixed, log-safe token: no whitespace, no control characters, bounded. */
function token(value: string, max = 64): string {
  return value.replace(/[^\w.:@/+-]/g, "_").slice(0, max) || "_";
}

/**
 * A trusted PTY whose leader is gone but whose group could not be confirmed gone, in "observe"
 * mode: one log line (no screen text, no argv beyond an executable basename) and one count.
 */
export function recordGroupUnconfirmedObserved(report: GroupUnconfirmedReport): void {
  observed++;
  const comm = report.comm.length > 0 ? report.comm.slice(0, 8).map((c) => token(c, 32)) : ["?"];
  console.warn(
    `[pty] group-unconfirmed mode=observe key=${token(report.key)} reason=${token(report.reason, 24)} survivors=${report.survivors ?? "?"} comm=${comm.join(",")}`,
  );
}

/** How many unconfirmed groups were observed without quarantine since this daemon started. For `/status`. */
export function groupUnconfirmedObservedCount(): number {
  return observed;
}

/** For tests only. */
export function __resetGroupUnconfirmedForTests(): void {
  observed = 0;
}
