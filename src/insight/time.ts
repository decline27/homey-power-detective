/** Local-time helpers that work in any time zone without a date library. */

/** Offset of the time zone from UTC at `t` (ms; positive east of Greenwich). */
export function tzOffsetMs(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Start and end (ms) of a local calendar day 'YYYY-MM-DD'. */
export function dayBounds(date: string, timeZone: string): { start: number; end: number } {
  const [y, m, d] = date.split('-').map(Number);
  const localMidnight = (yy: number, mm: number, dd: number) => {
    const guess = Date.UTC(yy, mm - 1, dd);
    // Two passes settle the offset across a DST change.
    let t = guess - tzOffsetMs(guess, timeZone);
    t = guess - tzOffsetMs(t, timeZone);
    return t;
  };
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    start: localMidnight(y, m, d),
    end: localMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
}

/** Start of the hour containing t (ms). Hours are whole in every European time zone. */
export const hourStart = (t: number) => Math.floor(t / 3_600_000) * 3_600_000;
