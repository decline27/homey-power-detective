/**
 * Heating from outdoor temperature, by the degree-day method: a day's heating need is the sum
 * over its hours of how far the outdoor temperature is below a base (17 °C, the Swedish
 * convention), as degree-days. Regressing the day's otherwise unexplained energy on its
 * degree-days gives the house's heating signature: kWh per degree-day (the slope) on top of a
 * weather-independent part (the intercept). The slope × a day's degree-days is that day's
 * heating estimate. It refuses to answer on thin or noisy data.
 */
import { hourStart } from './time';

export const HDD_BASE_C = 17;
const KEEP_HOURS = 24 * 35;
/** Hours with a temperature needed for a day's degree-days. */
const MIN_HOURS = 18;

export const SIGNATURE = {
  MIN_DAYS: 7,
  /** Degree-days between the mildest and coldest day, at least. */
  MIN_SPREAD: 3,
  MIN_R2: 0.5,
};

export class TemperatureBook {
  private hours = new Map<number, number>();
  private current: { hour: number; sum: number; n: number } | null = null;
  private last: { t: number; c: number } | null = null;

  record(t: number, c: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(c) || c < -60 || c > 60) return;
    const hour = hourStart(t);
    if (this.current?.hour !== hour) this.current = { hour, sum: 0, n: 0 };
    this.current.sum += c;
    this.current.n += 1;
    this.hours.set(hour, this.current.sum / this.current.n);
    if (!this.last || t >= this.last.t) this.last = { t, c };
    if (this.hours.size > KEEP_HOURS) {
      const old = [...this.hours.keys()].sort((a, b) => a - b).slice(0, this.hours.size - KEEP_HOURS);
      old.forEach(k => this.hours.delete(k));
    }
  }

  latest(): { t: number; c: number } | null {
    return this.last;
  }

  /** Heating degree-days in [start, end), or null with too few hours recorded. */
  degreeDays(bounds: { start: number; end: number }, base = HDD_BASE_C): number | null {
    const deficits: number[] = [];
    for (let h = hourStart(bounds.start); h < bounds.end; h += 3_600_000) {
      const c = this.hours.get(h);
      if (c !== undefined) deficits.push(Math.max(0, base - c));
    }
    const days = (bounds.end - bounds.start) / 86_400_000;
    if (deficits.length < MIN_HOURS * days) return null;
    return (deficits.reduce((s, x) => s + x, 0) / deficits.length) * days;
  }

  snapshot(): Array<[number, number]> {
    return [...this.hours.entries()];
  }

  static restore(snap: unknown): TemperatureBook {
    const b = new TemperatureBook();
    if (Array.isArray(snap)) {
      for (const row of snap) if (Array.isArray(row) && row.length === 2) b.record(Number(row[0]), Number(row[1]));
    }
    return b;
  }
}

export interface HeatingSignature {
  /** kWh per degree-day. */
  slope: number;
  /** kWh per day that does not depend on the weather. */
  intercept: number;
  r2: number;
  n: number;
}

/** Least squares of kWh on degree-days; null unless the data clearly show heating. */
export function heatingSignature(points: Array<{ hdd: number; kWh: number }>): HeatingSignature | null {
  const p = points.filter(x => Number.isFinite(x.hdd) && Number.isFinite(x.kWh));
  const n = p.length;
  if (n < SIGNATURE.MIN_DAYS) return null;
  const hdds = p.map(x => x.hdd);
  if (Math.max(...hdds) - Math.min(...hdds) < SIGNATURE.MIN_SPREAD) return null;
  const mx = hdds.reduce((s, x) => s + x, 0) / n;
  const my = p.reduce((s, x) => s + x.kWh, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const { hdd, kWh } of p) {
    sxx += (hdd - mx) ** 2;
    sxy += (hdd - mx) * (kWh - my);
    syy += (kWh - my) ** 2;
  }
  const slope = sxy / sxx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  if (!(slope > 0) || r2 < SIGNATURE.MIN_R2) return null;
  return { slope, intercept: my - slope * mx, r2, n };
}
