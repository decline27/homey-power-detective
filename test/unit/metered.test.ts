/**
 * Metered devices: what the house's own meters say, used two ways.
 *
 *   device power report ──> find the same change on the Pulse ──> phases + delay learned
 *        │                                                          │
 *        │                         fast and consistent? ── yes ──> subtracted live (from an off moment)
 *        │                                              └─ no ───> energy only
 *        └── energy counter ──> kWh per day (exact)
 */
import { METERED, MeteredDevices } from '../../src/homey/metered';
import { Reading } from '../../src/engine/engine';
import { Vec3 } from '../../src/engine/types';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 5, 22); // local midnight, Stockholm
const BASE: Vec3 = [200, 150, 100];

interface SimDevice {
  id: string;
  name: string;
  share: Vec3;
  /** Device power at t. */
  w: (t: number) => number;
  /** How late the device reports a change (ms). */
  lagMs: number;
  /** Shows on the house meter (false: behind another meter). */
  onPulse?: boolean;
}

/** Steps 10 s: the Pulse reading goes in raw; devices report their changes `lagMs` late. */
function run(md: MeteredDevices, devices: SimDevice[], from: number, to: number, seen: Reading[] = []) {
  const reported = new Map<string, number>();
  for (let t = from; t < to; t += 10_000) {
    const w: Vec3 = [...BASE];
    for (const d of devices) {
      if (d.onPulse === false) continue;
      for (let k = 0; k < 3; k++) w[k] += d.w(t) * d.share[k];
    }
    const r: Reading = { t, w, total: w[0] + w[1] + w[2] };
    md.observe(r);
    seen.push(md.residual(r));
    for (const d of devices) {
      const v = d.w(t - d.lagMs);
      if (reported.get(d.id) !== v) {
        reported.set(d.id, v);
        md.power(d.id, d.name, v, t);
      }
    }
  }
  return seen;
}

/** On for `onMin` every `periodMin`, from `offsetMin`. */
const sessions = (w: number, periodMin: number, onMin: number, offsetMin = 5) => (t: number) => {
  const m = (t - T0) / MIN - offsetMin;
  return m >= 0 && m % periodMin < onMin ? w : 0;
};

const charger = (): SimDevice => ({ id: 'easee', name: 'Easee ladder', share: [1 / 3, 1 / 3, 1 / 3], w: sessions(11000, 60, 30), lagMs: 0 });
const spa = (): SimDevice => ({ id: 'spa', name: 'BWA Spa', share: [0, 1, 0], w: sessions(3000, 45, 15, 10), lagMs: 5000 });
const melcloud = (): SimDevice => ({ id: 'hp', name: 'Värmepump', share: [1 / 3, 1 / 3, 1 / 3], w: sessions(1500, 50, 25, 20), lagMs: 3 * MIN });

const statusOf = (md: MeteredDevices, id: string) => md.status().find(s => s.id === id)!;

describe('learning each device from the Pulse', () => {
  test('a 3-phase charger reporting at once: phases and delay learned, then subtracted live', () => {
    const md = new MeteredDevices('Europe/Stockholm');
    const seen = run(md, [charger()], T0, T0 + 5 * 60 * MIN);
    const s = statusOf(md, 'easee');
    expect(s.live).toBe(true);
    expect(s.matches).toBeGreaterThanOrEqual(METERED.MIN_MATCHES);
    s.share!.forEach(x => expect(x).toBeCloseTo(1 / 3, 1));
    expect(Math.abs(s.lagMs!)).toBeLessThanOrEqual(10_000);
    // Once live, the charger is gone from what detection sees: only the base remains (outside the
    // one reading after each switch, before the charger's report arrives).
    const w = charger().w;
    const late = seen.filter(r => r.t > T0 + 4 * 60 * MIN && w(r.t) === w(r.t - 30_000));
    for (const r of late) {
      expect(Math.abs(r.w[0] - BASE[0])).toBeLessThan(60);
      expect(Math.abs(r.w[1] - BASE[1])).toBeLessThan(60);
      expect(Math.abs((r.total as number) - 450)).toBeLessThan(100);
    }
  });

  test('a single-phase spa reporting 5 s late: found on its phase, live', () => {
    const md = new MeteredDevices('Europe/Stockholm');
    run(md, [spa(), charger()], T0, T0 + 6 * 60 * MIN);
    const s = statusOf(md, 'spa');
    expect(s.live).toBe(true);
    expect(s.share![1]).toBeGreaterThan(0.85);
    expect(s.lagMs!).toBeGreaterThan(0);
    expect(s.lagMs!).toBeLessThanOrEqual(15_000);
  });

  test('switching together with a known device: its part is taken out, the share stays right', () => {
    const md = new MeteredDevices('Europe/Stockholm');
    // Every charger start lands on a spa start (both on the 90-minute grid from minute 10).
    const together = { ...charger(), w: sessions(11000, 90, 30, 10) };
    run(md, [spa(), together], T0, T0 + 9 * 60 * MIN);
    const s = statusOf(md, 'easee');
    s.share!.forEach(x => expect(x).toBeCloseTo(1 / 3, 1));
    expect(s.live).toBe(true);
  });

  test('switching together with a device not yet learned: the match is not used either way', () => {
    const md = new MeteredDevices('Europe/Stockholm');
    // Two unknown devices always switching in the same minute: neither can be told apart.
    const a = { ...charger(), id: 'a', name: 'A', w: sessions(4000, 60, 20, 5) };
    const b = { ...spa(), id: 'b', name: 'B', lagMs: 0, w: sessions(3000, 60, 20, 5) };
    run(md, [a, b], T0, T0 + 4 * 60 * MIN);
    expect(statusOf(md, 'a')).toMatchObject({ matches: 0, misses: 0, live: false });
    expect(statusOf(md, 'b')).toMatchObject({ matches: 0, misses: 0, live: false });
  });

  test('a heat pump reported minutes late (MELCloud): learned, but never subtracted live', () => {
    const md = new MeteredDevices('Europe/Stockholm');
    const seen = run(md, [melcloud()], T0, T0 + 8 * 60 * MIN);
    const s = statusOf(md, 'hp');
    expect(s.matches).toBeGreaterThanOrEqual(METERED.MIN_MATCHES);
    expect(s.lagMs!).toBeGreaterThan(2 * MIN);
    expect(s.live).toBe(false);
    // Detection still sees the heat pump: the residual is the raw reading.
    expect(Math.max(...seen.map(r => r.total as number))).toBeGreaterThan(1800);
  });

  test('a device whose power never shows on the Pulse is not subtracted', () => {
    const md = new MeteredDevices('Europe/Stockholm');
    run(md, [{ ...charger(), id: 'behind', name: 'Behind solar', onPulse: false }], T0, T0 + 5 * 60 * MIN);
    const s = statusOf(md, 'behind');
    expect(s.live).toBe(false);
    expect(s.misses).toBeGreaterThanOrEqual(METERED.MIN_MATCHES);
  });

  test('goes live only at a moment the device is off, so detection never sees a step that is not there', () => {
    const md = new MeteredDevices('Europe/Stockholm');
    const seen = run(md, [charger()], T0, T0 + 5 * 60 * MIN);
    // Wherever the raw meter is flat for a minute, the residual is flat too: subtraction never
    // starts in the middle of a run (that would be a step down that is not there).
    const raw = (t: number) => 450 + sessions(11000, 60, 30)(t);
    for (let i = 6; i < seen.length; i++) {
      const flat = [0, 1, 2, 3, 4, 5, 6, 7].every(k => i - k >= 0 && raw(seen[i - k].t) === raw(seen[i].t));
      if (flat) expect(Math.abs((seen[i].total as number) - (seen[i - 6].total as number))).toBeLessThan(500);
    }
    // ...and it did start: some readings while the charger runs are already clean.
    expect(seen.some(r => (r.total as number) < 600 && sessions(11000, 60, 30)(r.t) > 0)).toBe(true);
  });

  test('the residual is never below zero, per phase or in total', () => {
    const md = new MeteredDevices('Europe/Stockholm');
    run(md, [charger()], T0, T0 + 4 * 60 * MIN);
    // The charger reports 11 kW, but the house meter shows almost nothing (a wrong report).
    md.power('easee', 'Easee ladder', 11000, T0 + 4 * 60 * MIN);
    const r = md.residual({ t: T0 + 4 * 60 * MIN + 10_000, w: [300, 200, 100], total: 600 });
    expect(r.w.every(x => x >= 0)).toBe(true);
    expect(r.total).toBeGreaterThanOrEqual(0);
  });

  test('a live device silent for hours while "on" is no longer trusted', () => {
    const md = new MeteredDevices('Europe/Stockholm');
    run(md, [charger()], T0, T0 + 5 * 60 * MIN);
    const at = T0 + 5 * 60 * MIN;
    md.power('easee', 'Easee ladder', 7000, at);
    const raw: Reading = { t: at + 10_000, w: [2500, 2500, 2500], total: 7500 };
    expect(md.residual(raw).total).toBeLessThan(1000);
    const later: Reading = { t: at + METERED.STALE_MS + MIN, w: [2500, 2500, 2500], total: 7500 };
    expect(md.residual(later).total).toBe(7500);
    expect(md.running(later.t).some(d => d.id === 'easee')).toBe(false);
  });
});

describe('energy per device and day', () => {
  test('from the energy counter, across midnight, with a daily reset and a counter swap', () => {
    const md = new MeteredDevices('Europe/Stockholm');
    md.counter('easee', 12000, T0 - 2 * MIN);
    md.power('easee', 'Easee ladder', 0, T0 - 2 * MIN);
    md.counter('easee', 12003.5, T0 + 60 * MIN); // 3.5 kWh on 6 Oct
    md.counter('easee', 12010, T0 + 23 * 60 * MIN); // 6.5 more
    md.counter('easee', 12011, T0 + 25 * 60 * MIN); // 1 kWh on 7 Oct
    md.counter('easee', 99999, T0 + 26 * 60 * MIN); // a new counter: not 87988 kWh
    md.counter('easee', 100000, T0 + 27 * 60 * MIN); // 1 kWh
    // MELCloud style: a counter that starts from zero again each day.
    md.power('hp', 'Värmepump', 0, T0);
    md.counter('hp', 46, T0 + 60 * MIN);
    md.counter('hp', 48.5, T0 + 20 * 60 * MIN); // 2.5
    md.counter('hp', 0.4, T0 + 24 * 60 * MIN + 30 * MIN); // reset at midnight, 0.4 since
    expect(md.energyOn('2026-10-06')).toEqual(
      expect.arrayContaining([
        { id: 'easee', name: 'Easee ladder', kWh: expect.closeTo(10, 6) },
        { id: 'hp', name: 'Värmepump', kWh: expect.closeTo(2.5, 6) },
      ])
    );
    expect(md.energyOn('2026-10-07')).toEqual(
      expect.arrayContaining([
        { id: 'easee', name: 'Easee ladder', kWh: expect.closeTo(2, 6) },
        { id: 'hp', name: 'Värmepump', kWh: expect.closeTo(0.4, 6) },
      ])
    );
  });

  test('without a counter: power integrated over the readings', () => {
    const md = new MeteredDevices('Europe/Stockholm');
    run(md, [spa()], T0, T0 + 3 * 60 * MIN);
    // 3 kW for 15 of every 45 min over 3 h (from minute 10): 4 runs = 3 kWh.
    expect(md.energyOn('2026-10-06')[0].kWh).toBeCloseTo(3, 1);
  });
});

describe('now, and across restarts', () => {
  test('running devices; snapshot and restore keep what was learned and counted', () => {
    const md = new MeteredDevices('Europe/Stockholm');
    run(md, [charger()], T0, T0 + 5 * 60 * MIN + 10 * MIN);
    expect(md.running(T0 + 5 * 60 * MIN + 10 * MIN)).toEqual([{ id: 'easee', name: 'Easee ladder', w: 11000 }]);
    const r = MeteredDevices.restore(JSON.parse(JSON.stringify(md.snapshot())), 'Europe/Stockholm');
    expect(r.status()).toEqual(md.status());
    expect(r.energyOn('2026-10-06')).toEqual(md.energyOn('2026-10-06'));
    expect(MeteredDevices.restore({ version: 99 }, 'Europe/Stockholm').status()).toEqual([]);
  });
});
