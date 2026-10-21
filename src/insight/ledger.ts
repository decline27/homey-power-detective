/**
 * A day's energy, accounted for: what the house used in total (from the meter), what the
 * always-on base took, what each found load took, and what is left unexplained. Costs use the
 * hourly price when one is known, splitting each activation across the hours it ran in.
 */
import { DayRecord, percentileW } from '../engine/day-meter';
import { Activation, LoadCluster, activationW } from '../engine/types';
import { hourStart } from './time';

/** Price per kWh for the hour starting at `hour` (ms), or null when unknown. */
export type PriceAt = (hour: number) => number | null;

export interface LedgerRow {
  loadId: string;
  kWh: number;
  cost: number | null;
  activations: number;
}

export interface DayLedger {
  date: string;
  totalKWh: number;
  coveredHours: number;
  baseloadW: number | null;
  baseloadKWh: number;
  loads: LedgerRow[];
  unexplainedKWh: number;
  /** Share of the day's energy assigned to the base load or a found load (0..1). */
  explainedShare: number;
}

/** Energy (kWh) and cost of an activation inside [from, to), hour by hour. */
export function activationEnergy(a: Activation, from: number, to: number, price?: PriceAt): { kWh: number; cost: number | null } {
  const lo = Math.max(a.start, from);
  const hi = Math.min(a.end, to);
  if (hi <= lo) return { kWh: 0, cost: price ? 0 : null };
  const w = activationW(a);
  let kWh = 0;
  let cost: number | null = price ? 0 : null;
  for (let h = hourStart(lo); h < hi; h += 3_600_000) {
    const part = (w * (Math.min(hi, h + 3_600_000) - Math.max(lo, h))) / 3.6e9;
    kWh += part;
    if (cost !== null && price) {
      const p = price(h);
      cost = p === null ? null : cost + part * p;
    }
  }
  return { kWh, cost };
}

export function buildDayLedger(
  day: DayRecord,
  loads: LoadCluster[],
  bounds: { start: number; end: number },
  price?: PriceAt
): DayLedger {
  const baseloadW = percentileW(day, 0.05);
  const coveredHours = day.coveredMs / 3_600_000;
  const baseloadKWh = baseloadW === null ? 0 : (baseloadW * coveredHours) / 1000;
  const rows: LedgerRow[] = loads
    .map(c => {
      let kWh = 0;
      let cost: number | null = price ? 0 : null;
      let n = 0;
      for (const a of c.activations) {
        if (a.end <= bounds.start || a.start >= bounds.end) continue;
        const e = activationEnergy(a, bounds.start, bounds.end, price);
        kWh += e.kWh;
        cost = cost === null || e.cost === null ? null : cost + e.cost;
        n++;
      }
      return { loadId: c.id, kWh, cost, activations: n };
    })
    .filter(r => r.activations > 0)
    .sort((a, b) => b.kWh - a.kWh);
  const loadKWh = rows.reduce((s, r) => s + r.kWh, 0);
  const explained = Math.min(day.kWh, baseloadKWh + loadKWh);
  return {
    date: day.date,
    totalKWh: day.kWh,
    coveredHours,
    baseloadW,
    baseloadKWh,
    loads: rows,
    unexplainedKWh: Math.max(0, day.kWh - baseloadKWh - loadKWh),
    explainedShare: day.kWh > 0 ? explained / day.kWh : 0,
  };
}
