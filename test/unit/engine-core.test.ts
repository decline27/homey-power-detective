import { classify, clusterActivations, clusterId, median, phaseLabel, phaseShare } from '../../src/engine/clustering';
import { decompose } from '../../src/engine/decompose';
import { LevelChange, StepDetector } from '../../src/engine/detector';
import { PowerEngine } from '../../src/engine/engine';
import { Pairer, cosine, matchScore } from '../../src/engine/pairer';
import { LoadRegistry } from '../../src/engine/registry';
import { Activation, LoadCluster, StepEvent, Vec3, activationKWh, activationW } from '../../src/engine/types';
import { MIN, T0, every, synthHouse } from '../helpers/synth';

const run = (readings: Array<{ t: number; w: Vec3; total?: number }>) => {
  const d = new StepDetector();
  const out: LevelChange[] = [];
  for (const r of readings) out.push(...d.push(r));
  return out;
};

describe('StepDetector', () => {
  test('a one-phase load switching on and off gives two changes on that phase, sized by the total', () => {
    const h = synthHouse([{ w: [1300, 0, 0], on: [[T0 + 10 * MIN, T0 + 30 * MIN]] }], 40 * MIN);
    const c = run(h);
    expect(c).toHaveLength(2);
    expect(c[0].phase[0]).toBeGreaterThan(1250);
    expect(Math.abs(c[0].phase[1]) + Math.abs(c[0].phase[2])).toBe(0);
    expect(c[0].total).toBeCloseTo(1300, -2);
    expect(c[0].t).toBe(T0 + 10 * MIN);
    expect(c[1].total).toBeCloseTo(-1300, -2);
  });

  test('a 3-phase load is one change across all three phases', () => {
    const c = run(synthHouse([{ w: [300, 280, 270], on: [[T0 + 5 * MIN, T0 + 9 * MIN]] }], 15 * MIN));
    expect(c).toHaveLength(2);
    expect(c[0].phase.every(v => v > 200)).toBe(true);
  });

  test('noise inside the band gives nothing', () => {
    expect(run(synthHouse([], 60 * MIN, { noise: 80 }))).toHaveLength(0);
  });

  test('a load pulsing on another phase does not hide a step', () => {
    // 1.3 kW on L2 for 30 s every 3 min (a coffee machine), a 3 kW heater on L3 for 8 min.
    const pulses = every(3, 0.5, 20);
    const h = synthHouse(
      [
        { w: [0, 1300, 0], on: pulses },
        { w: [0, 0, 3000], on: [[T0 + 20 * MIN + 5000, T0 + 28 * MIN + 5000]] },
      ],
      60 * MIN
    );
    const l3 = run(h).filter(c => Math.abs(c.phase[2]) > 2000);
    expect(l3).toHaveLength(2);
    expect(l3[0].phase[2]).toBeCloseTo(3000, -2);
  });

  test('an inverter ramp over a minute is one change', () => {
    const c = run(synthHouse([{ w: [300, 280, 270], on: [[T0 + 5 * MIN, T0 + 15 * MIN]], rampMs: 60_000 }], 20 * MIN));
    expect(c.filter(x => x.total > 0)).toHaveLength(1);
    expect(c[0].total).toBeGreaterThan(700);
  });

  test('a gap or an invalid reading starts over; readings out of order are ignored', () => {
    const d = new StepDetector();
    const w: Vec3 = [100, 100, 100];
    expect(d.push({ t: T0, w })).toEqual([]);
    expect(d.push({ t: T0 - 1000, w: [5000, 0, 0] })).toEqual([]);
    expect(d.push({ t: T0 + 10_000, w: [NaN, 100, 100] })).toEqual([]);
    // After the gap the first reading is a new level, not a step from the old one.
    expect(d.push({ t: T0 + 10 * MIN, w: [3000, 100, 100] })).toEqual([]);
    expect(d.push({ t: T0 + 10 * MIN + 10_000, w: [3000, 100, 100] })).toEqual([]);
  });

  test('averaged data (one reading a minute) still joins the phases of one load', () => {
    const h = synthHouse([{ w: [300, 260, 250], on: [[T0 + 10 * MIN, T0 + 16 * MIN]] }], 30 * MIN, { stepMs: 60_000 });
    const c = run(h);
    expect(c.length).toBeGreaterThanOrEqual(2);
    expect(c[0].phase.every(v => v > 150)).toBe(true);
  });

  test('the total is not used when it moved implausibly (another load in the same moment)', () => {
    const d = new StepDetector();
    const out: LevelChange[] = [];
    for (let i = 0; i < 20; i++) {
      const on = i >= 10;
      out.push(...d.push({ t: T0 + i * 10_000, w: [on ? 1300 : 0, 0, 0], total: on ? 9000 : 0 }));
    }
    expect(out[0].total).toBeCloseTo(1300, 0);
  });
});

describe('decompose', () => {
  const change = (phase: Vec3, total: number): LevelChange => ({ t: T0, settledAt: T0 + 20_000, phase, total });

  test('a one-direction change becomes one step sized by the total', () => {
    const s = decompose(change([200, 160, 150], 850), []);
    expect(s).toHaveLength(1);
    expect(s[0].delta.reduce((a, b) => a + b, 0)).toBeCloseTo(850);
    expect(s[0].raw).toEqual([200, 160, 150]);
  });

  test('a small change is dropped', () => {
    expect(decompose(change([100, 0, 0], 100), [])).toEqual([]);
  });

  test('a running heater stopping as a 3-phase load starts is split using the running heater', () => {
    // L1 heater 1300 W off, heat pump +300/+160/+150 on, in the same reading.
    const heater: StepEvent = { t: T0 - 20 * MIN, settledAt: T0 - 20 * MIN, delta: [1300, 0, 0], raw: [1300, 0, 0] };
    const s = decompose(change([-1000, 160, 150], -690), [heater]);
    expect(s).toHaveLength(2);
    expect(s[0].delta).toEqual([-1300, -0, -0]);
    expect(s[1].delta[0]).toBeGreaterThan(200);
    expect(s[1].delta.reduce((a, b) => a + b, 0)).toBeCloseTo(610);
  });

  test('without a running load to explain it, a mixed change is split by sign', () => {
    const s = decompose(change([-1000, 600, 0], -400), []);
    expect(s).toHaveLength(2);
    expect(s.map(x => Math.sign(x.delta.reduce((a, b) => a + b, 0))).sort()).toEqual([-1, 1]);
  });
});

describe('Pairer', () => {
  const step = (t: number, delta: Vec3): StepEvent => ({ t, settledAt: t, delta });

  test('pairs a stop with the start of the same shape', () => {
    const p = new Pairer();
    expect(p.push(step(T0, [1300, 0, 0]))).toBeNull();
    expect(p.push(step(T0 + MIN, [0, 2000, 0]))).toBeNull();
    const a = p.push(step(T0 + 20 * MIN, [-1290, 0, 0]));
    expect(a).toEqual({ start: T0, end: T0 + 20 * MIN, delta: [1295, 0, 0] });
    expect(p.running()).toHaveLength(1);
  });

  test('a stop on other phases, or of a very different size, does not pair', () => {
    const p = new Pairer();
    p.push(step(T0, [1300, 0, 0]));
    expect(p.push(step(T0 + MIN, [0, -1300, 0]))).toBeNull();
    expect(p.push(step(T0 + MIN, [-300, 0, 0]))).toBeNull();
  });

  test('a stop much smaller than its start keeps the start size (another load switched with it)', () => {
    const p = new Pairer();
    p.push(step(T0, [1300, 0, 0]));
    const a = p.push(step(T0 + 20 * MIN, [-650, 0, 0]));
    expect(a?.delta).toEqual([1300, 0, 0]);
  });

  test('starts with no stop expire after a day; restore keeps the open starts', () => {
    const p = new Pairer();
    p.push(step(T0, [1300, 0, 0]));
    expect(p.push(step(T0 + 25 * 3_600_000, [-1300, 0, 0]))).toBeNull();
    const q = new Pairer();
    q.restore([step(T0, [500, 500, 500])]);
    expect(q.push(step(T0 + MIN, [-500, -500, -500]))).not.toBeNull();
  });

  test('match score', () => {
    expect(cosine([1, 0, 0], [0, 1, 0])).toBe(0);
    expect(cosine([0, 0, 0], [1, 0, 0])).toBe(0);
    expect(matchScore([1000, 0, 0], [-1000, 0, 0])).toBeCloseTo(1);
    expect(matchScore([1000, 0, 0], [-3000, 0, 0])).toBe(0);
  });
});

describe('clustering', () => {
  const act = (start: number, minutes: number, delta: Vec3): Activation => ({ start, end: start + minutes * MIN, delta });

  test('groups by phase and size; rhythm, period, energy per day', () => {
    const heater = every(63, 21, 23).map(([s]) => act(s, 21, [1330, 0, 0]));
    const hp = every(25, 4, 50, 7).map(([s], i) => act(s, 4, [330 + (i % 5) * 10, 270, 250]));
    const kettle = [act(T0 + 300 * MIN, 3, [0, 2000, 0]), act(T0 + 900 * MIN, 3, [0, 2050, 0]), act(T0 + 1200 * MIN, 3, [0, 1980, 0])];
    const loads = clusterActivations([...heater, ...hp, ...kettle], { from: T0, to: T0 + 24 * 60 * MIN });
    expect(loads.map(l => l.phases).sort()).toEqual(['3-phase', 'L1', 'L2']);
    const h = loads.find(l => l.phases === 'L1')!;
    expect(h.rhythmic).toBe(true);
    expect(h.periodMinutes).toBeCloseTo(63);
    expect(h.kWhPerDay).toBeCloseTo((1330 * 21 * 23) / 60 / 1000, 1);
    expect(loads[0]).toBe(h); // largest energy first
    expect(loads.find(l => l.phases === 'L2')!.rhythmic).toBe(false);
  });

  test('a load needs at least three activations; ids are stable and unique', () => {
    expect(clusterActivations([act(T0, 5, [1000, 0, 0]), act(T0 + MIN * 60, 5, [1000, 0, 0])])).toEqual([]);
    expect(clusterId('L1+L2', 2000)).toBe(clusterId('L1+L2', 2000));
    const two = clusterActivations([
      ...[0, 1, 2].map(i => act(T0 + i * 60 * MIN, 5, [1000, 0, 0])),
      ...[0, 1, 2].map(i => act(T0 + (i * 60 + 30) * MIN, 5, [1000, 0, 0.0001])),
    ]);
    expect(new Set(two.map(c => c.id)).size).toBe(two.length);
  });

  test('a missed activation does not break the rhythm (robust spread)', () => {
    const acts = every(60, 20, 24).filter((_, i) => i !== 10).map(([s]) => act(s, 20, [1300, 0, 0]));
    expect(clusterActivations(acts)[0].rhythmic).toBe(true);
  });

  test('classify: nearest load, not one far longer than the load ever runs', () => {
    const heater = every(63, 21, 12).map(([s]) => act(s, 21, [1330, 0, 0]));
    const loads = clusterActivations(heater);
    expect(classify(act(T0, 22, [1300, 0, 0]), loads)?.id).toBe(loads[0].id);
    expect(classify(act(T0, 300, [1300, 0, 0]), loads)).toBeNull();
    expect(classify(act(T0, 20, [0, 1300, 0]), loads)).toBeNull();
    expect(classify(act(T0, 20, [0, 0, 0]), loads)).toBeNull();
  });

  test('helpers', () => {
    expect(phaseShare([1000, -50, 0])).toEqual([1, 0, 0]);
    expect(phaseShare([0, 0, 0])).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(phaseLabel([0.5, 0.5, 0])).toBe('L1+L2');
    expect(phaseLabel([0.34, 0.33, 0.33])).toBe('3-phase');
    expect(median([])).toBeNaN();
    expect(median([3, 1, 2, 4])).toBe(2.5);
    expect(activationW(act(T0, 60, [500, 500, 0]))).toBe(1000);
    expect(activationKWh(act(T0, 60, [500, 500, 0]))).toBeCloseTo(1);
  });
});

describe('missed stops (runs far longer than the load runs)', () => {
  const act2 = (start: number, minutes: number, delta: Vec3): Activation => ({ start, end: start + minutes * MIN, delta });
  // 40 floor-heater runs of 21 min, 6 of them with a missed stop (147 min): 15 % bad, beyond a p90.
  const runs = Array.from({ length: 40 }, (_, i) => act2(T0 + i * 63 * MIN, i % 7 === 3 ? 147 : 21, [1330, 0, 0]));

  test('the plausible run length is a robust bound (Q3 + 3 IQR + 10 min), not fooled by the bad runs', () => {
    const [c] = clusterActivations(runs);
    expect(c.maxMinutes).toBeCloseTo(31, 0);
  });

  test('daily energy counts a missed-stop run at the typical length', () => {
    const [c] = clusterActivations(runs, { from: T0, to: T0 + 40 * 63 * MIN });
    const days = (40 * 63) / 1440;
    expect(c.kWhPerDay).toBeCloseTo((40 * 1330 * 21) / 60 / 1000 / days, 1);
  });

  test('runs far shorter than the load runs are another appliance of its size: a kettle is not the floor heating', () => {
    // Floor heating 1380 W on L1, 21 min every 63 min; a 1100 W kettle on L1, 2-3 min, 4 times.
    const floor = Array.from({ length: 20 }, (_, i) => act2(T0 + i * 63 * MIN, 21, [1380, 0, 0]));
    const kettle = [2, 3, 2, 3].map((m, i) => act2(T0 + (i * 300 + 30) * MIN, m, [1100, 0, 0]));
    const loads = clusterActivations([...floor, ...kettle]);
    expect(loads).toHaveLength(2);
    const heater = loads.find(c => c.medianMinutes > 10)!;
    expect(heater.count).toBe(20);
    expect(heater.rhythmic).toBe(true);
    expect(loads.find(c => c.medianMinutes < 10)!.count).toBe(4);
    // Classified the same way once finished; still running, a start can be the heater.
    const kettleRun = act2(T0, 2, [1380, 0, 0]);
    expect(classify(kettleRun, [heater])).toBeNull();
    expect(classify(kettleRun, [heater], undefined, true)).toBe(heater);
    expect(classify(act2(T0, 20, [1380, 0, 0]), [heater])).toBe(heater);
  });

  test('loads whose runs vary a lot keep their long runs (an EV charging 30 min to 6 h)', () => {
    const ev = [30, 60, 90, 120, 180, 240, 300, 360, 45, 150].map((m, i) => act2(T0 + i * 24 * 60 * MIN, m, [3680, 3680, 3680]));
    const [c] = clusterActivations(ev);
    expect(c.maxMinutes).toBeGreaterThanOrEqual(360);
    const kWh = ev.reduce((s, a) => s + activationKWh(a), 0);
    expect(c.kWhPerDay * ((ev[ev.length - 1].end - ev[0].start) / 86_400_000)).toBeCloseTo(kWh, 6);
  });
});

describe('PowerEngine end to end (synthetic house)', () => {
  // Kitchen floor: 1330 W on L1, 21 min every 63 min. Heat pump: 3-phase 850 W, 4 min, often
  // starting in the same reading as the floor heating stops.
  const day = 24 * 60 * MIN;
  const floor = every(63, 21, 22);
  const hp = floor.map(([, off]) => [off, off + 4 * MIN] as [number, number]);
  const readings = synthHouse(
    [
      { w: [1330, 0, 0], on: floor },
      { w: [330, 270, 250], on: hp, rampMs: 30_000 },
    ],
    day
  );

  test('finds both loads, with the heater rhythmic and the heat pump on all three phases', () => {
    const e = new PowerEngine('Europe/Stockholm');
    readings.forEach(r => e.push(r));
    const loads = e.loads();
    const heater = loads.find(l => l.phases === 'L1')!;
    const pump = loads.find(l => l.phases === '3-phase')!;
    expect(heater.count).toBeGreaterThanOrEqual(21);
    expect(heater.rhythmic).toBe(true);
    expect(heater.medianW).toBeCloseTo(1330, -2);
    expect(pump.count).toBeGreaterThanOrEqual(20);
    expect(pump.medianMinutes).toBeCloseTo(4, 0);
    expect(e.days()[0].kWh).toBeGreaterThan(10);
  });

  test('snapshot and restore keep activations, open starts and days', () => {
    const e = new PowerEngine('Europe/Stockholm');
    readings.slice(0, 2000).forEach(r => e.push(r));
    const snap = JSON.parse(JSON.stringify(e.snapshot()));
    const f = PowerEngine.restore(snap, 'Europe/Stockholm');
    expect(f.allActivations().length).toBe(e.allActivations().length);
    expect(f.days()).toEqual(e.days());
    expect(f.running().length).toBe(e.running().length);
    expect(f.observedFrom()).toBe(T0);
    expect(PowerEngine.restore({ version: 2 }).allActivations()).toEqual([]);
    expect(PowerEngine.restore({ version: 1, activations: [[1, 2, 3], 'x'], open: null, days: 'x' }).allActivations()).toEqual([]);
  });
});

describe('LoadRegistry (stable ids)', () => {
  const cluster = (id: string, share: Vec3, medianW: number, kWhPerDay = 1): LoadCluster => ({
    id, phases: 'L1', share, medianW, medianMinutes: 20, p90Minutes: 25, maxMinutes: 35, minMinutes: 5, count: 10, startsPerDay: 20, kWhPerDay,
    periodMinutes: 60, periodCv: 0.1, rhythmic: true, activations: [],
  });

  test('a load keeps its id when its median drifts across an id bucket', () => {
    const r = new LoadRegistry();
    const first = r.assign([cluster('L1-72', [1, 0, 0], 1408)], T0);
    const later = r.assign([cluster('L1-73', [1, 0, 0], 1409)], T0 + MIN);
    expect(later[0].id).toBe(first[0].id);
  });

  test('two similar loads keep their ids when their order flips; a new load gets a new id', () => {
    const r = new LoadRegistry();
    const a = r.assign([cluster('L1-72', [1, 0, 0], 1300, 5), cluster('L1-72', [0.8, 0.2, 0], 1350, 1)], T0);
    const b = r.assign([cluster('L1-72', [0.8, 0.2, 0], 1350, 9), cluster('L1-72', [1, 0, 0], 1300, 1)], T0 + MIN);
    expect(b.find(c => c.share[0] === 1)!.id).toBe(a.find(c => c.share[0] === 1)!.id);
    expect(b.find(c => c.share[0] === 0.8)!.id).toBe(a.find(c => c.share[0] === 0.8)!.id);
    expect(new Set(a.map(c => c.id)).size).toBe(2);
    const c = r.assign([cluster('L2-80', [0, 1, 0], 3000)], T0 + 2 * MIN);
    expect(a.map(x => x.id)).not.toContain(c[0].id);
  });

  test('survives a snapshot; forgets loads not seen for 90 days; ignores bad entries', () => {
    const r = new LoadRegistry();
    const id = r.assign([cluster('L1-72', [1, 0, 0], 1300)], T0)[0].id;
    const back = new LoadRegistry([...JSON.parse(JSON.stringify(r.snapshot())), { id: 'bad' }]);
    expect(back.assign([cluster('L1-71', [1, 0, 0], 1290)], T0 + MIN)[0].id).toBe(id);
    back.assign([], T0 + 100 * 86_400_000);
    expect(back.snapshot()).toEqual([]);
  });
});
