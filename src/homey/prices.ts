/**
 * Hourly electricity prices, recorded as Homey reports them (the Tibber home device's
 * `measure_price_total`, or any device with a price capability the user picks), with a flat
 * price from the settings as the fallback.
 */
import { PriceAt } from '../insight/ledger';
import { hourStart } from '../insight/time';

export const PRICE_CAPABILITIES = ['measure_price_total', 'measure_price'];
const KEEP_HOURS = 24 * 35;

export class PriceBook {
  private hours = new Map<number, number>();

  record(t: number, price: number): void {
    if (!Number.isFinite(price) || price < -10 || price > 100) return;
    this.hours.set(hourStart(t), price);
    if (this.hours.size > KEEP_HOURS) {
      const oldest = [...this.hours.keys()].sort((a, b) => a - b).slice(0, this.hours.size - KEEP_HOURS);
      oldest.forEach(k => this.hours.delete(k));
    }
  }

  /** Price for an hour: the recorded one, else the flat fallback, else null. */
  priceAt(flat: number | null): PriceAt {
    return (hour: number) => this.hours.get(hourStart(hour)) ?? flat;
  }

  /** Mean of the recorded hours in [from, to), or the flat price when none were recorded. */
  average(from: number, to: number, flat: number | null): number | null {
    const v = [...this.hours.entries()].filter(([h]) => h >= from && h < to).map(([, p]) => p);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : flat;
  }

  snapshot(): Array<[number, number]> {
    return [...this.hours.entries()];
  }

  static restore(snap: unknown): PriceBook {
    const b = new PriceBook();
    if (Array.isArray(snap)) {
      for (const row of snap) if (Array.isArray(row) && row.length === 2) b.record(Number(row[0]), Number(row[1]));
    }
    return b;
  }
}
