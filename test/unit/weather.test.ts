/**
 * Heating from outdoor temperature: the degree-day method. Energy that rises as it gets colder
 * is heating; the slope of the day's unexplained kWh against heating degree-days says how much.
 */
import { TemperatureBook, heatingSignature, HDD_BASE_C } from '../../src/insight/weather';

const HOUR = 3_600_000;
const DAY = { start: Date.UTC(2026, 9, 5, 22), end: Date.UTC(2026, 9, 6, 22) };

describe('temperature book', () => {
  test('hourly means and heating degree-days for a day', () => {
    const b = new TemperatureBook();
    for (let t = DAY.start; t < DAY.end; t += 10 * 60_000) b.record(t, 7);
    expect(HDD_BASE_C).toBe(17);
    expect(b.degreeDays(DAY)).toBeCloseTo(10, 9);
    // Two readings in one hour: the hour is their mean.
    const c = new TemperatureBook();
    for (let h = 0; h < 24; h++) {
      c.record(DAY.start + h * HOUR, 4);
      c.record(DAY.start + h * HOUR + 30 * 60_000, 6);
    }
    expect(c.degreeDays(DAY)).toBeCloseTo(12, 9);
  });

  test('warm hours count zero, not negative; implausible values are ignored', () => {
    const b = new TemperatureBook();
    for (let h = 0; h < 24; h++) b.record(DAY.start + h * HOUR, h < 12 ? 21 : 13);
    b.record(DAY.start + 5 * HOUR, 85);
    b.record(DAY.start + 6 * HOUR, Number.NaN);
    expect(b.degreeDays(DAY)).toBeCloseTo(2, 9);
  });

  test('too few hours with data: no degree-days rather than a guess', () => {
    const b = new TemperatureBook();
    for (let h = 0; h < 17; h++) b.record(DAY.start + h * HOUR, 5);
    expect(b.degreeDays(DAY)).toBeNull();
    // From 18 hours on, the mean of the hours present stands for the day.
    b.record(DAY.start + 17 * HOUR, 5);
    expect(b.degreeDays(DAY)).toBeCloseTo(12, 9);
  });

  test('latest value, snapshot and restore, old hours dropped', () => {
    const b = new TemperatureBook();
    for (let d = 0; d < 40; d++) b.record(DAY.start + d * 24 * HOUR, d);
    expect(b.latest()).toEqual({ t: DAY.start + 39 * 24 * HOUR, c: 39 });
    const r = TemperatureBook.restore(JSON.parse(JSON.stringify(b.snapshot())));
    expect(r.snapshot()).toEqual(b.snapshot());
    expect(b.snapshot().length).toBeLessThanOrEqual(35 * 24);
    expect(TemperatureBook.restore('nonsense').snapshot()).toEqual([]);
  });
});

describe('heating signature', () => {
  // A house using 2 kWh/day regardless of weather plus 0.8 kWh per degree-day, with noise.
  const days = (n: number, noise = 0.3) =>
    Array.from({ length: n }, (_, i) => {
      const hdd = 2 + ((i * 7) % 13);
      return { hdd, kWh: 2 + 0.8 * hdd + (((i * 31) % 7) / 6 - 0.5) * 2 * noise };
    });

  test('recovers how much the house heats per degree-day', () => {
    const sig = heatingSignature(days(14))!;
    expect(sig.slope).toBeCloseTo(0.8, 1);
    expect(sig.intercept).toBeCloseTo(2, 0);
    expect(sig.r2).toBeGreaterThan(0.95);
    expect(sig.n).toBe(14);
  });

  test('refuses to guess: under a week, no spread in temperature, colder-is-less, or mostly noise', () => {
    expect(heatingSignature(days(6))).toBeNull();
    expect(heatingSignature(Array.from({ length: 10 }, () => ({ hdd: 8, kWh: 9 })))).toBeNull();
    expect(heatingSignature(days(14).map(d => ({ hdd: d.hdd, kWh: 20 - d.kWh })))).toBeNull();
    expect(heatingSignature(days(14, 30))).toBeNull();
  });
});
