/**
 * Whole-house energy per local day, kept online from the total power: kWh, the time covered and
 * a power histogram (for the always-on base load, the 5th percentile of the day's power).
 * Small and fixed in size, so a month of days can be stored.
 */
export const HIST_BIN_W = 25;
export const HIST_BINS = 1200; // 0..30 kW
export const MAX_DAYS = 35;

export interface DayRecord {
  date: string;
  kWh: number;
  coveredMs: number;
  /** Seconds spent in each 25 W power bin. */
  hist: number[];
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

export function localDate(t: number, timeZone: string): string {
  let f = dateFormats.get(timeZone);
  if (!f) {
    // en-CA gives YYYY-MM-DD. Building a formatter is slow, so there is one per time zone.
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFormats.set(timeZone, f);
  }
  return f.format(new Date(t));
}

export class DayMeter {
  private days: DayRecord[] = [];
  private last: { t: number; w: number } | null = null;
  /** Local date of the current quarter hour: formatting a date for every reading is slow. */
  private dateCache: { quarter: number; date: string } | null = null;

  private dateOf(t: number): string {
    const quarter = Math.floor(t / 900_000);
    if (this.dateCache?.quarter !== quarter) this.dateCache = { quarter, date: localDate(t, this.timeZone) };
    return this.dateCache.date;
  }

  constructor(private readonly timeZone: string, private readonly maxGapMs = 90_000) {}

  push(t: number, totalW: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(totalW) || totalW < 0) {
      this.last = null;
      return;
    }
    const prev = this.last;
    this.last = { t, w: totalW };
    if (!prev || t <= prev.t || t - prev.t > this.maxGapMs) return;
    // The previous reading holds until this one (a meter reports momentary power).
    const day = this.day(this.dateOf(prev.t));
    const dt = t - prev.t;
    day.kWh += (prev.w * dt) / 3.6e9;
    day.coveredMs += dt;
    const bin = Math.min(HIST_BINS - 1, Math.floor(prev.w / HIST_BIN_W));
    day.hist[bin] += dt / 1000;
  }

  private day(date: string): DayRecord {
    let d = this.days.find(x => x.date === date);
    if (!d) {
      d = { date, kWh: 0, coveredMs: 0, hist: new Array(HIST_BINS).fill(0) };
      this.days.push(d);
      this.days.sort((a, b) => (a.date < b.date ? -1 : 1));
      if (this.days.length > MAX_DAYS) this.days.shift();
    }
    return d;
  }

  get(date: string): DayRecord | undefined {
    return this.days.find(x => x.date === date);
  }

  all(): DayRecord[] {
    return this.days.map(d => ({ ...d, hist: [...d.hist] }));
  }

  restore(days: DayRecord[]): void {
    this.days = days
      .filter(d => d && typeof d.date === 'string' && Array.isArray(d.hist) && d.hist.length === HIST_BINS)
      .slice(-MAX_DAYS);
  }
}

/** Power the house never goes below (W): the given percentile of the day's power. */
export function percentileW(day: DayRecord, p = 0.05): number | null {
  const total = day.hist.reduce((s, x) => s + x, 0);
  if (total <= 0) return null;
  let acc = 0;
  for (let i = 0; i < day.hist.length; i++) {
    acc += day.hist[i];
    if (acc >= p * total) return (i + 0.5) * HIST_BIN_W;
  }
  return null;
}
