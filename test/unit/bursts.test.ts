/**
 * The kettle and the oven are the same size on the same phase (L3, ~1.8 and ~1.7 kW on the Homey,
 * 2026-11): the kettle runs once, the oven heats up for ~10 min, then holds its temperature
 * ~1.5 min on, ~2 min off. Each group is split into its bursts and its lone runs; live, the gap
 * to the last run like it decides. A thermostat load with the odd close pair stays one load.
 */
import { classify, clusterActivations, minutesSinceSimilar } from '../../src/engine/clustering';
import { Activation, Vec3 } from '../../src/engine/types';

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 10);
const run = (start: number, minutes: number, delta: Vec3): Activation => ({ start, end: start + minutes * MIN, delta });
const kettle = (t: number) => run(t, 2.5, [0, 0, 1850]);
const oven = (t: number): Activation[] => {
  const out = [run(t, 10, [0, 0, 1700])];
  let at = t + 12 * MIN;
  for (let i = 0; i < 8; i++, at += 3.5 * MIN) out.push(run(at, 1.5, [0, 0, 1690]));
  return out;
};
const week = (): Activation[] => {
  const acts: Activation[] = [];
  for (let d = 0; d < 7; d++) {
    acts.push(kettle(T0 + d * DAY + 7 * 60 * MIN), kettle(T0 + d * DAY + 12 * 60 * MIN));
    acts.push(...oven(T0 + d * DAY + 17 * 60 * MIN));
  }
  return acts.sort((a, b) => a.start - b.start);
};
const window = { from: T0, to: T0 + 7 * DAY };

describe('bursts and lone runs of one size', () => {
  const loads = clusterActivations(week(), window);

  test('kettle and oven are two loads; the oven is the bursty one', () => {
    const l3 = loads.filter(l => l.phases === 'L3');
    expect(l3).toHaveLength(2);
    const lone = l3.find(l => !l.bursty)!;
    const burst = l3.find(l => l.bursty)!;
    expect(lone.count).toBe(14);
    expect(burst.count).toBe(63);
    expect(lone.startsPerDay).toBeCloseTo(2, 5);
  });

  test('live: a run on its own is the kettle; one right after another, or a long one, the oven', () => {
    const lone = loads.find(l => l.phases === 'L3' && !l.bursty)!;
    const burst = loads.find(l => l.phases === 'L3' && l.bursty)!;
    const t = T0 + 8 * DAY + 17 * 60 * MIN;
    const acts = [...week(), ...oven(t)];
    const now = run(t + 70 * MIN, 0, [0, 0, 1800]);
    expect(classify(now, loads, undefined, true, { sinceSimilarMin: minutesSinceSimilar(now, acts) })?.id).toBe(lone.id);
    const cycle = run(t + 12 * MIN + 2 * 3.5 * MIN, 0, [0, 0, 1700]);
    const before = acts.filter(a => a.end <= cycle.start);
    expect(minutesSinceSimilar(cycle, before)).toBeCloseTo(2, 5);
    expect(classify(cycle, loads, undefined, true, { sinceSimilarMin: minutesSinceSimilar(cycle, before) })?.id).toBe(burst.id);
    const heatUp = run(t + 200 * MIN, 6, [0, 0, 1800]);
    expect(classify(heatUp, loads, undefined, true, { sinceSimilarMin: null })?.id).toBe(burst.id);
  });

  test('a thermostat load with the odd close pair stays one load', () => {
    const acts: Activation[] = [];
    for (let i = 0; i < 60; i++) {
      const t = T0 + i * 45 * MIN;
      acts.push(run(t, 12, [1140, 0, 0]));
      if (i % 10 === 0) acts.push(run(t + 13 * MIN, 5, [1140, 0, 0])); // a stop seen late
    }
    expect(clusterActivations(acts, window).filter(l => l.phases === 'L1')).toHaveLength(1);
  });
});
