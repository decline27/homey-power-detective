/** Local-time helpers that work in any time zone without a date library. */

/** One formatter per time zone and day bounds per date: building them is slow. */
const formats = new Map<string, Intl.DateTimeFormat>();
const bounds = new Map<string, { start: number; end: number }>();

/** Offset of the time zone from UTC at `t` (ms; positive east of Greenwich). */
export function tzOffsetMs(t: number, timeZone: string): number {
  let f = formats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formats.set(timeZone, f);
  }
  const parts = f.formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Start and end (ms) of a local calendar day 'YYYY-MM-DD'. */
export function dayBounds(date: string, timeZone: string): { start: number; end: number } {
  const key = `${timeZone}|${date}`;
  const cached = bounds.get(key);
  if (cached) return cached;
  if (bounds.size > 1000) bounds.clear();
  const [y, m, d] = date.split('-').map(Number);
  const localMidnight = (yy: number, mm: number, dd: number) => {
    const guess = Date.UTC(yy, mm - 1, dd);
    // Two passes settle the offset across a DST change.
    let t = guess - tzOffsetMs(guess, timeZone);
    t = guess - tzOffsetMs(t, timeZone);
    return t;
  };
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const out = {
    start: localMidnight(y, m, d),
    end: localMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()),
  };
  bounds.set(key, out);
  return out;
}

/** Start of the hour containing t (ms). Hours are whole in every European time zone. */
export const hourStart = (t: number) => Math.floor(t / 3_600_000) * 3_600_000;
