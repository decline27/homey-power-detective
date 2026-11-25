import { BALANCED, BalancedTracker } from '../../src/engine/balanced';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 0, 0); // a Monday, 01:00 Stockholm
const tz = 'Europe/Stockholm';

/** Feeds `minutes` of readings every 10 s: per-phase base plus a balanced load and a single-phase one. */
function feed(b: BalancedTracker, from: number, minutes: number, hpW: number, l2W = 0) {
  for (let t = from; t < from + minutes * MIN; t += 10_000) {
    const w: [number, number, number] = [200 + hpW / 3, 160 + hpW / 3 + l2W, 250 + hpW / 3];
    b.push(t, w, w[0] + w[1] + w[2]);
  }
}

describe('balanced 3-phase tracker', () => {
  test('follows a heat pump that runs for hours, not a single-phase load', () => {
    const b = new BalancedTracker(tz);
    // Day 1 learns the base (heat pump off part of the day).
    feed(b, T0, 600, 0);
    feed(b, T0 + 600 * MIN, 840, 1200);
    // Day 2: a 2.8 kW spa on L2 alone, then the heat pump for 6 h.
    const d2 = T0 + 1440 * MIN;
    feed(b, d2, 60, 0, 2800);
    expect(b.nowW()).toBe(0);
    feed(b, d2 + 60 * MIN, 360, 1500);
    expect(b.onSince()).not.toBeNull();
    expect(b.nowW()).toBeGreaterThan(1400);
    expect(b.nowW()).toBeLessThan(1600);
    feed(b, d2 + 420 * MIN, 60, 0);
    const last = b.allIntervals().slice(-1)[0];
    expect(Math.abs(last.start - (d2 + 60 * MIN))).toBeLessThanOrEqual(BALANCED.HOLD_MS + 10_000);
    expect((last.end - last.start) / MIN).toBeCloseTo(360, -1);
  });

  test('the day without it keeps the always-on base when the heat pump never stops', () => {
    const b = new BalancedTracker(tz);
    feed(b, T0, 600, 0);
    feed(b, T0 + 600 * MIN, 840, 1200);
    // A cold day: on from 03:00 local, through the rest of the day.
    feed(b, T0 + 1440 * MIN, 120, 0);
    feed(b, T0 + 1560 * MIN, 1320, 1200);
    const rest = b.restDays().find(d => d.date === '2026-11-03')!;
    expect(rest.coveredMs / MIN).toBeCloseTo(120, -1);
    const tot = rest.hist.reduce((s, x) => s + x, 0);
    let acc = 0;
    let p5 = 0;
    for (let i = 0; i < rest.hist.length; i++) if ((acc += rest.hist[i]) >= 0.05 * tot) { p5 = i * 25; break; }
    expect(p5).toBeLessThan(700); // the house's 610 W, not 1810 W
  });

  test('a phase a live device over-subtracts to near zero does not teach the base', () => {
    const b = new BalancedTracker(tz);
    feed(b, T0, 600, 0);
    feed(b, T0 + 600 * MIN, 840, 1200);
    // Next day: an hour with L2 at 0 (a spa's estimate above its real draw), the rest normal.
    const d2 = T0 + 1440 * MIN;
    for (let t = d2; t < d2 + 60 * MIN; t += 10_000) b.push(t, [200, 0, 250], 450);
    feed(b, d2 + 60 * MIN, 1380, 0);
    // Day 3 learns from days 1-2: still the house's 160 W on its lowest phase, not 0.
    expect(b.baseW(d2 + 1440 * MIN + 60 * MIN)).toBeGreaterThan(140);
  });

  test('survives a snapshot', () => {
    const b = new BalancedTracker(tz);
    feed(b, T0, 600, 0);
    feed(b, T0 + 600 * MIN, 120, 1200);
    feed(b, T0 + 720 * MIN, 30, 0);
    const r = BalancedTracker.restore(JSON.parse(JSON.stringify(b.snapshot())), tz);
    expect(r.allIntervals()).toHaveLength(1);
    expect(r.energy()).toEqual(b.energy());
  });
});
