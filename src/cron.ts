import { shiftDateToOffset } from "./timezone";

function matchCronField(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? parseInt(stepStr) : 1;

    if (range === "*") {
      if (value % step === 0) return true;
      continue;
    }

    if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
      continue;
    }

    if (parseInt(range) === value) return true;
  }
  return false;
}

export function cronMatches(expr: string, date: Date, timezoneOffsetMinutes = 0): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = expr.trim().split(/\s+/);
  const shifted = shiftDateToOffset(date, timezoneOffsetMinutes);
  const d = {
    minute: shifted.getUTCMinutes(),
    hour: shifted.getUTCHours(),
    dayOfMonth: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    dayOfWeek: shifted.getUTCDay(),
  };

  return (
    matchCronField(minute, d.minute) &&
    matchCronField(hour, d.hour) &&
    matchCronField(dayOfMonth, d.dayOfMonth) &&
    matchCronField(month, d.month) &&
    matchCronField(dayOfWeek, d.dayOfWeek)
  );
}

/**
 * Upper bound on the forward scan, in days. A valid expression can
 * legitimately have a multi-year gap between matches (`0 0 29 2 *` fires
 * every four years), so the bound has to cover that; beyond it the
 * expression is treated as never matching and `null` is returned.
 */
const MAX_SCAN_DAYS = 366 * 5;

/**
 * Next instant strictly after `after` that matches `expr`, or `null` when
 * nothing matches within `MAX_SCAN_DAYS`.
 *
 * The scan works day by day: a day whose date fields (day-of-month, month,
 * day-of-week) cannot match is skipped in one step, and only candidate days
 * are walked minute by minute. Both checks reuse `matchCronField` /
 * `cronMatches`, so the result is exactly what a minute-by-minute scan
 * would return — without the 48-hour cap that used to make this function
 * return the scan-end date as if it were a match (issue #437).
 */
export function nextCronMatch(expr: string, after: Date, timezoneOffsetMinutes = 0): Date | null {
  const [, , dayOfMonth, month, dayOfWeek] = expr.trim().split(/\s+/);
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let day = 0; day < MAX_SCAN_DAYS; day++) {
    const shifted = shiftDateToOffset(d, timezoneOffsetMinutes);
    // Minutes left in the current day of the target offset, from `d` inclusive.
    const remaining = 24 * 60 - (shifted.getUTCHours() * 60 + shifted.getUTCMinutes());
    const dateMatches =
      matchCronField(dayOfMonth, shifted.getUTCDate()) &&
      matchCronField(month, shifted.getUTCMonth() + 1) &&
      matchCronField(dayOfWeek, shifted.getUTCDay());
    if (dateMatches) {
      for (let i = 0; i < remaining; i++) {
        if (cronMatches(expr, d, timezoneOffsetMinutes)) return d;
        d.setMinutes(d.getMinutes() + 1);
      }
    } else {
      d.setMinutes(d.getMinutes() + remaining);
    }
  }
  return null;
}
