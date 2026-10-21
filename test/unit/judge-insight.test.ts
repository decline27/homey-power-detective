import { clusterActivations } from '../../src/engine/clustering';
import { DayMeter, HIST_BINS, localDate, percentileW } from '../../src/engine/day-meter';
import { matchReferences } from '../../src/engine/labels';
import { fits, learnProfile, learnRunFilter, passes, runsOf } from '../../src/engine/profile';
import { energyRatio, intervalsFromPower, makeScore, matchIntervals, sessions } from '../../src/engine/score';
import { Activation, Vec3 } from '../../src/engine/types';
import { evaluateExperiment, hoursNeeded, poissonCdf } from '../../src/insight/experiments';
import { buildFindings, shiftSaving } from '../../src/insight/findings';
import { activationEnergy, buildDayLedger } from '../../src/insight/ledger';
import { summarize, templateSummary } from '../../src/insight/summary';
import { dayBounds, hourStart, tzOffsetMs } from '../../src/insight/time';
import { MIN, T0, every } from '../helpers/synth';

const act = (start: number, minutes: number, delta: Vec3): Activation => ({ start, end: start + minutes * MIN, delta });
const H = 3_600_000;

describe('score', () => {
  test('one-to-one matching with timing tolerance and a run-length check', () => {
    const ref = [{ start: T0 + 5 * MIN, end: T0 + 10 * MIN }, { start: T0 + 60 * MIN, end: T0 + 65 * MIN }];
    const det = [{ start: T0 + 2 * MIN, end: T0 + 6 * MIN }, { start: T0 + 30 * MIN, end: T0 + 34 * MIN }];
    expect(matchIntervals(ref, det, 6 * MIN)).toMatchObject({ tp: 1, fp: 1, fn: 1 });
    // A 60-minute run is not a 5-minute one, however they overlap...
    expect(matchIntervals(ref, [{ start: T0, end: T0 + 60 * MIN }], MIN).tp).toBe(0);
    // ...unless run lengths are allowed to differ (a heater inside a wash programme).
    expect(matchIntervals(ref, [{ start: T0, end: T0 + 60 * MIN }], MIN, Infinity).tp).toBe(1);
    // An instant inside the window matches.
    expect(matchIntervals(ref, [{ start: T0 + 61 * MIN, end: T0 + 61 * MIN }], 6 * MIN).tp).toBe(1);
  });

  test('sessions, scores and power-to-interval conversion', () => {
    expect(sessions([{ start: 10, end: 20 }, { start: 0, end: 5 }, { start: 100, end: 110 }], 10)).toEqual([
      { start: 0, end: 20 },
      { start: 100, end: 110 },
    ]);
    expect(makeScore(0, 0, 0)).toEqual({ tp: 0, fp: 0, fn: 0, precision: 0, recall: 0, f1: 0 });
    expect(makeScore(9, 1, 0).f1).toBeCloseTo(0.947, 3);
    const readings = [0, 0, 1500, 1500, 0, 1500, null, 1500].map((v, i) => ({ t: T0 + i * MIN, v }));
    expect(intervalsFromPower(readings, 50, 5 * MIN)).toEqual([
      { start: T0 + 2 * MIN, end: T0 + 4 * MIN },
      { start: T0 + 5 * MIN, end: T0 + 6 * MIN },
      { start: T0 + 7 * MIN, end: T0 + 7 * MIN },
    ]);
    // A reading gap closes a run at the last reading.
    expect(intervalsFromPower([{ t: 0, v: 900 }, { t: 1000, v: 900 }, { t: 10 * MIN, v: 900 }], 50, MIN)).toEqual([
      { start: 0, end: 1000 },
      { start: 10 * MIN, end: 10 * MIN },
    ]);
    expect(energyRatio(5, 10)).toBe(0.5);
    expect(energyRatio(5, 0)).toBeNull();
  });
});

describe('matchReferences (naming loads from metered devices)', () => {
  const heater = every(63, 21, 20).map(([s]) => act(s, 21, [1330, 0, 0]));
  const hp = every(63, 4, 20, 21).map(([s]) => act(s, 4, [330, 270, 250]));
  const loads = clusterActivations([...heater, ...hp]);
  const hpLoad = loads.find(l => l.phases === '3-phase')!;

  test('the heat pump load matches MELCloud runs that arrive minutes late', () => {
    const melcloud = hp.map(a => ({ start: a.start + 3 * MIN, end: a.end + 4 * MIN }));
    const m = matchReferences(loads, [{ id: 'hp', name: 'Heat pump', intervals: melcloud }], { tolMs: 6 * MIN, gapMs: MIN });
    expect(m).toHaveLength(1);
    expect(m[0].clusterIds).toEqual([hpLoad.id]);
    expect(m[0].score.f1).toBeCloseTo(1);
  });

  test('a load belongs to one device only; devices with no runs are skipped', () => {
    const intervals = hp.map(a => ({ start: a.start, end: a.end }));
    const m = matchReferences(
      loads,
      [
        { id: 'a', name: 'A', intervals },
        { id: 'b', name: 'B', intervals: intervals.slice(0, 10) },
        { id: 'c', name: 'C', intervals: [] },
      ],
      { tolMs: MIN, gapMs: MIN }
    );
    expect(m.flatMap(x => x.clusterIds).filter(id => id === hpLoad.id)).toHaveLength(1);
    expect(m.find(x => x.referenceId === 'c')).toBeUndefined();
  });
});

describe('run profiles and filters', () => {
  const dish = [0, 1, 2, 3, 4, 5].flatMap(d => [act(T0 + d * 24 * H, 8, [0, 0, 2900]), act(T0 + d * 24 * H + 45 * MIN, 8, [0, 0, 2900])]);
  const kettle = [0, 1, 2, 3].map(d => act(T0 + d * 24 * H + 10 * H, 3, [0, 0, 2900]));

  test('runsOf groups activations into runs with features', () => {
    const runs = runsOf(dish, 45 * MIN);
    expect(runs).toHaveLength(6);
    expect(runs[0]).toMatchObject({ count: 2, spanMinutes: 53 });
    expect(runs[0].kWh).toBeCloseTo((2900 * 16) / 60 / 1000);
  });

  test('a learned filter keeps dishwasher runs and drops kettle-sized runs', () => {
    const runs = runsOf([...dish, ...kettle], 45 * MIN);
    const confirmed = runs.map(r => r.count === 2);
    const f = learnRunFilter(runs, confirmed)!;
    expect(f.trainF1).toBe(1);
    expect(runs.filter(r => passes(f, r))).toHaveLength(6);
    expect(learnRunFilter(runs.slice(0, 2), [true, true])).toBeNull();
    expect(learnRunFilter(runs, [true])).toBeNull();
  });

  test('a range profile from confirmed runs', () => {
    const p = learnProfile(runsOf(dish, 45 * MIN))!;
    expect(fits(p, { count: 2, spanMinutes: 53, kWh: 0.77 })).toBe(true);
    expect(fits(p, { count: 1, spanMinutes: 3, kWh: 0.14 })).toBe(false);
    expect(learnProfile([])).toBeNull();
  });
});

describe('time and day meter', () => {
  test('local day bounds across the October DST change in Stockholm', () => {
    const b = dayBounds('2026-10-25', 'Europe/Stockholm');
    expect(b.end - b.start).toBe(25 * H);
    expect(new Date(b.start).toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(tzOffsetMs(Date.UTC(2026, 6, 1), 'Europe/Stockholm')).toBe(2 * H);
    expect(hourStart(T0 + 61 * MIN)).toBe(T0 + H);
    expect(localDate(Date.UTC(2026, 9, 20, 22, 30), 'Europe/Stockholm')).toBe('2026-10-21');
  });

  test('integrates energy per local day, skips gaps, finds the base load', () => {
    const m = new DayMeter('UTC', 90_000);
    for (let i = 0; i <= 360; i++) m.push(T0 + i * 10_000, i < 180 ? 400 : 1400); // 1 h
    m.push(T0 + 2 * H, 400); // after a gap: not counted
    m.push(NaN, 5);
    const d = m.all()[0];
    expect(d.kWh).toBeCloseTo(0.9, 2);
    expect(d.coveredMs).toBe(H);
    expect(percentileW(d)).toBeCloseTo(412.5);
    expect(percentileW({ date: 'x', kWh: 0, coveredMs: 0, hist: new Array(HIST_BINS).fill(0) })).toBeNull();
    const n = new DayMeter('UTC');
    n.restore([...m.all(), { date: 'bad' } as never]);
    expect(n.get(d.date)?.kWh).toBeCloseTo(d.kWh);
  });
});

describe('ledger and findings', () => {
  const heater = every(63, 21, 23).map(([s]) => act(s, 21, [1330, 0, 0]));
  const hp = every(25, 4, 57, 3).map(([s]) => act(s, 4, [330, 270, 250]));
  const loads = clusterActivations([...heater, ...hp], { from: T0, to: T0 + 24 * H });
  const price = (h: number) => (new Date(h).getUTCHours() < 6 ? 0.5 : 2);

  test('activation energy splits across hours and prices', () => {
    const e = activationEnergy(act(T0 + 5 * H + 30 * MIN, 60, [1000, 0, 0]), 0, Infinity, price);
    expect(e.kWh).toBeCloseTo(1);
    expect(e.cost).toBeCloseTo(0.5 * 0.5 + 0.5 * 2);
    expect(activationEnergy(act(T0, 60, [1000, 0, 0]), T0 + 2 * H, T0 + 3 * H)).toEqual({ kWh: 0, cost: null });
    expect(activationEnergy(act(T0, 60, [1000, 0, 0]), 0, Infinity, () => null).cost).toBeNull();
  });

  test('day ledger: total, base load, loads and the unexplained rest', () => {
    const m = new DayMeter('UTC');
    for (let t = T0; t <= T0 + 24 * H; t += 60_000) m.push(t, 300 + (heater.some(a => t >= a.start && t < a.end) ? 1330 : 0));
    const l = buildDayLedger(m.all()[0], loads, { start: T0, end: T0 + 24 * H }, price);
    expect(l.baseloadW).toBeCloseTo(312.5);
    expect(l.loads[0].kWh).toBeCloseTo((1330 * 21 * 23) / 60 / 1000, 1);
    expect(l.loads[0].cost).not.toBeNull();
    expect(l.explainedShare).toBeGreaterThan(0.95);
  });

  test('findings: the rhythmic heater, short cycling and the base load, ranked by money', () => {
    const f = buildFindings({
      loads,
      names: {},
      heatPumpLoadIds: [],
      baseloadW: 300,
      avgPrice: 2,
      currency: 'SEK',
      heatPumpCop: 3,
      timeZone: 'UTC',
    });
    expect(f.map(x => x.kind)).toEqual(['rhythmic-heater', 'base-load', 'short-cycling']);
    const h = f[0];
    expect(h.title).toContain('every 63 min');
    expect(h.savingPerMonth).toBeCloseTo(h.costPerMonth! * (2 / 3));
    expect(h.experimentHours).toBe(4);
    expect(f[2].title).toContain('likely the heat pump');
  });

  test('a named heat pump is not called a heater; no price, no money', () => {
    const pump = loads.find(l => l.phases === '3-phase')!;
    const f = buildFindings({
      loads,
      names: { [pump.id]: 'Heat pump' },
      heatPumpLoadIds: [pump.id],
      baseloadW: 50,
      avgPrice: null,
      currency: 'SEK',
      heatPumpCop: 3,
      timeZone: 'UTC',
    });
    expect(f.find(x => x.kind === 'short-cycling')?.title).toMatch(/^Heat pump starts/);
    expect(f.every(x => x.costPerMonth === null)).toBe(true);
    expect(f.find(x => x.kind === 'base-load')).toBeUndefined();
  });

  test('shiftable: a big load run at expensive hours', () => {
    const dish = [0, 1, 2, 3].map(d => act(T0 + d * 24 * H + 18 * H, 60, [0, 0, 2000]));
    const ls = clusterActivations(dish);
    const s = shiftSaving(dish, price, 'UTC')!;
    expect(s.runs).toBe(4);
    expect(s.saving).toBeCloseTo(4 * 2 * (2 - 0.5));
    const f = buildFindings({ loads: ls, names: {}, heatPumpLoadIds: [], baseloadW: null, avgPrice: 2, currency: 'SEK', heatPumpCop: 3, price, timeZone: 'UTC' });
    expect(f[0].kind).toBe('shiftable');
    expect(f[0].savingPerMonth).toBeCloseTo((12 / 4) * 30);
    expect(shiftSaving(dish, () => null, 'UTC')).toBeNull();
  });
});

describe('experiments', () => {
  const exp = { id: 'e', loadId: 'L1-72', label: 'the kitchen floor', startedAt: T0, hours: 4 };

  test('confirmed when a load that runs every hour stays quiet for 4 hours', () => {
    const r = evaluateExperiment(exp, T0 + 5 * H, 60 / 63, 0);
    expect(r.status).toBe('confirmed');
    expect(r.pValue!).toBeLessThan(0.05);
  });

  test('rejected when it keeps running; running and inconclusive otherwise', () => {
    expect(evaluateExperiment(exp, T0 + 3 * H, 1, 3).status).toBe('rejected');
    expect(evaluateExperiment(exp, T0 + H, 1, 0).status).toBe('running');
    expect(evaluateExperiment(exp, T0 + 5 * H, 0.25, 0).status).toBe('inconclusive');
    expect(evaluateExperiment(exp, T0 + 5 * H, 0, 0).pValue).toBeNull();
  });

  test('poisson and test length', () => {
    expect(poissonCdf(0, 3)).toBeCloseTo(Math.exp(-3));
    expect(poissonCdf(2, 1)).toBeCloseTo(Math.exp(-1) * 2.5);
    expect(hoursNeeded(1)).toBe(3);
    expect(hoursNeeded(0)).toBe(48);
    expect(hoursNeeded(100)).toBe(2);
  });
});

describe('summary', () => {
  const input = {
    language: 'en' as const,
    currency: 'SEK',
    days: 7,
    totalKWh: 280,
    explainedShare: 0.82,
    loads: [{ name: 'Kitchen floor', kWhPerDay: 9.6, costPerMonth: 670, confirmed: false }],
    findings: [
      {
        id: 'x',
        kind: 'rhythmic-heater' as const,
        title: 'Kitchen floor runs every 63 min, 9.6 kWh/day',
        detail: '',
        kWhPerMonth: 288,
        costPerMonth: 670,
        savingPerMonth: 447,
        confidence: 'medium' as const,
        experimentHours: 4,
      },
    ],
    validation: [{ device: 'Heat pump', f1: 0.9 }],
  };

  test('the template states the numbers it was given', () => {
    const t = templateSummary(input);
    expect(t).toContain('280 kWh');
    expect(t).toContain('82 %');
    expect(t).toContain('447 SEK/month');
    expect(t).toContain('(unconfirmed)');
    expect(templateSummary({ ...input, language: 'sv' })).toContain('Gör först');
  });

  test('Claude writes it when a key is given; the template is the fallback', async () => {
    let sent = '';
    const ok = await summarize(input, {
      apiKey: 'k',
      transport: async body => {
        sent = body;
        return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text: 'Switch the kitchen floor off.' }] }) };
      },
    });
    expect(ok).toEqual({ text: 'Switch the kitchen floor off.', source: 'claude' });
    expect(JSON.parse(sent).system).toContain('Use only the numbers');
    expect((await summarize(input)).source).toBe('template');
    expect((await summarize(input, { apiKey: 'k', transport: async () => ({ status: 401, body: '' }) })).error).toBe('Anthropic API 401');
    expect((await summarize(input, { apiKey: 'k', transport: async () => { throw new Error('offline'); } })).error).toBe('offline');
    expect((await summarize(input, { apiKey: 'k', transport: async () => ({ status: 200, body: '{"content":[]}' }) })).error).toBe('empty answer');
  });
});
