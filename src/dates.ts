/**
 * Date arguments the way people say them.
 *
 * "Mail from last week" is a normal request and `2026-08-03T00:00:00.000Z` is
 * not, so every date argument accepts both, plus the shorthand a model reaches
 * for on its own: `7d`, `36h`, `yesterday`.
 */

const RELATIVE = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hours?|d|days?|w|weeks?|mo|months?|y|years?)(\s+ago)?$/i;

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
  mo: 2_592_000_000,
  month: 2_592_000_000,
  months: 2_592_000_000,
  y: 31_536_000_000,
  year: 31_536_000_000,
  years: 31_536_000_000,
};

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/**
 * Resolves a date argument. Relative values count back from now; bare day names
 * resolve to the start of that day in the local zone, which is what "since
 * yesterday" means to the person asking.
 */
export function parseWhen(value: string | undefined, now = new Date()): Date | undefined {
  const input = value?.trim();
  if (!input) return undefined;

  const lower = input.toLowerCase();
  if (lower === "now") return now;
  if (lower === "today") return startOfDay(now);
  if (lower === "yesterday") return startOfDay(new Date(now.getTime() - 86_400_000));
  if (lower === "last week" || lower === "week") return startOfDay(new Date(now.getTime() - 7 * 86_400_000));
  if (lower === "last month" || lower === "month") return startOfDay(new Date(now.getTime() - 30 * 86_400_000));

  const relative = RELATIVE.exec(lower);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = UNIT_MS[relative[2].toLowerCase()];
    if (unit) return new Date(now.getTime() - amount * unit);
  }

  // A bare `2026-08-03` is read as local midnight, not as UTC midnight, so a
  // search "since 3 August" does not silently start in the previous evening.
  const bareDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (bareDate) {
    return new Date(Number(bareDate[1]), Number(bareDate[2]) - 1, Number(bareDate[3]), 0, 0, 0, 0);
  }

  const parsed = new Date(input);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  throw new Error(
    `Cannot read \`${input}\` as a date. Use an ISO date (2026-08-03), a date and time ` +
      "(2026-08-03 14:00), a relative span (7d, 36h, 2w) or `today` / `yesterday`.",
  );
}

/** Human-friendly rendering for message listings. */
export function formatDate(date: Date | string | undefined): string | undefined {
  if (!date) return undefined;
  const value = typeof date === "string" ? new Date(date) : date;
  return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
}
