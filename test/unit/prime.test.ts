import { BALANCED, BalancedTracker } from '../../src/engine/balanced';
import { lowestPhaseDay } from '../../src/homey/prime';

const MIN = 60_000;
const tz = 'Europe/Stockholm';
const T0 = Date.UTC(2026, 10, 18, 23, 0); // 2026-11-19 00:00 Stockholm

/** A raw-record day: every 10 s, currents for a house whose lowest phase draws `low(t)` W. */
function rawDay(start: number, minutes: number, low: (t: number) => number): string {
  const lines = ['#name,x,Pulse'];
  for (let t = start; t < start + minutes * MIN; t += 10_000) {
    const l3 = low(t);
    const w = [l3 + 500, l3 + 300, l3];
    lines.push(`${t},P,${w[0] + w[1] + w[2]}`);
    w.forEach((x, k) => lines.push(`${t},I${k + 1},${(x / 230).toFixed(3)}`));
  }
  return lines.join('\n');
}

describe('base learned from the raw record', () => {
  test('a day\'s lowest-phase histogram as the tracker builds it', () => {
    const d = lowestPhaseDay(rawDay(T0, 600, () => 150));
    expect(d.coveredMs).toBeGreaterThan(9.9 * 3_600_000);
    const peak = d.hist.indexOf(Math.max(...d.hist));
    expect(Math.abs(peak * BALANCED.BIN_W - 150)).toBeLessThanOrEqual(BALANCED.BIN_W);
  });

  test('a tracker installed this evening gets the base of the past days, not of tonight', () => {
    const b = new BalancedTracker(tz);
    // Tonight: the heat pump (1 kW, 333 W a phase) on all evening over a 120 W base.
    const tonight = Date.UTC(2026, 10, 25, 17, 30);
    for (let t = tonight; t < tonight + 210 * MIN; t += 10_000) b.push(t, [953, 753, 453], 2159);
    const now = tonight + 210 * MIN;
    expect(b.baseW(now)).toBeGreaterThan(400); // tonight alone: the heat pump looks like base
    // The record's past days: the heat pump off for a while each night.
    for (let d = 0; d < 6; d++) {
      const day = T0 + d * 1440 * MIN;
      const raw = rawDay(day, 1440, t => ((t - day) / MIN < 120 ? 120 : 453));
      const { coveredMs, hist } = lowestPhaseDay(raw);
      b.learnBase(new Date(day + 3_600_000).toISOString().slice(0, 10), hist, coveredMs);
    }
    expect(b.baseW(now)).toBeLessThan(160);
    // it switches on after its hold (BALANCED.HOLD_MS)
    for (let t = now; t <= now + BALANCED.HOLD_MS + 20_000; t += 10_000) b.push(t, [953, 753, 453], 2159);
    expect(b.nowW()).toBeGreaterThan(900);
  });

  test('learned days survive a restart and do not count as heat pump energy', () => {
    const b = new BalancedTracker(tz);
    const { coveredMs, hist } = lowestPhaseDay(rawDay(T0, 1440, () => 130));
    b.learnBase('2026-11-19', hist, coveredMs);
    expect(b.needsBase('2026-11-19')).toBe(false);
    const r = BalancedTracker.restore(JSON.parse(JSON.stringify(b.snapshot())), tz);
    expect(r.needsBase('2026-11-19')).toBe(false);
    expect(r.energy()).toEqual([]);
    expect(r.baseW(T0 + 3 * 1440 * MIN)).toBeLessThan(150);
  });
});
