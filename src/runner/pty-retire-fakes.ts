/**
 * Test support for code that takes the common retirement as a dependency (`retireProcessGroup`):
 * the sweeper's survivor retry. A fake never reaches a real pid.
 */
import type { RetireGroupInput, RetireGroupOutcome } from "./pty-group-kill.js";

/** An outcome in which the leader and its group are both gone (`gone`) or both still there. */
export function retireOutcome(
  gone: boolean,
  extra: Partial<RetireGroupOutcome> = {},
): RetireGroupOutcome {
  return {
    leaderGone: gone,
    groupGone: gone,
    reason: null,
    survivors: gone ? 0 : undefined,
    comm: [],
    groupId: null,
    members: [],
    ...extra,
  };
}

/** A `retire` dependency that decides from the input whether the group is gone. */
export function retireFake(
  decide: (input: RetireGroupInput) => boolean | Promise<boolean>,
): (input: RetireGroupInput) => Promise<RetireGroupOutcome> {
  return async (input) => retireOutcome(await decide(input));
}
