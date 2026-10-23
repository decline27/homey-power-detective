import { analyse, displayName, meteredRunOf, nameFromDevices } from '../../src/homey/analysis';
import { latestFromDevice, meterCandidates, pickMeter, readingFrom } from '../../src/homey/meter';
import { silentStretches } from '../../src/engine/labels';
import { MeteredDevices } from '../../src/homey/metered';
import { PriceBook } from '../../src/homey/prices';
import { ReferenceTracker } from '../../src/homey/references';
import { PowerEngine } from '../../src/engine/engine';
import { MIN, T0, every, synthHouse } from '../helpers/synth';

const pulse = {
  id: 'pulse',
  name: 'Pulse',
  capabilities: ['measure_power', 'meter_power.imported', 'measure_current.L1', 'measure_current.L2', 'measure_current.L3'],
  energyObj: { cumulative: true },
};

describe('house meter', () => {
  test('picks the home meter, or the chosen device, or none when unclear', () => {
    const plug = { id: 'plug', capabilities: ['measure_power'] };
    const p1 = { id: 'p1', capabilities: ['measure_power', 'meter_power.imported'] };
    expect(pickMeter([plug, pulse, p1], '')?.id).toBe('pulse');
    expect(pickMeter([plug, p1], undefined)?.id).toBe('p1');
    expect(pickMeter([plug, pulse], 'plug')?.id).toBe('plug');
    expect(pickMeter([pulse, { ...pulse, id: 'x' }], '')).toBeNull();
    expect(pickMeter([p1, { ...p1, id: 'y' }], '')).toBeNull();
    expect(meterCandidates([plug, p1, pulse]).map(c => [c.id, c.phases])).toEqual([['pulse', true], ['p1', false]]);
  });

  test('readings: current × voltage per phase, nominal 230 V, total-only fallback, stale values dropped', () => {
    const now = T0;
    const m = new Map([
      ['measure_power', { value: 1500, at: now }],
      ['measure_current.L1', { value: 5, at: now }],
      ['measure_current.L2', { value: 1, at: now }],
      ['measure_current.L3', { value: 1, at: now }],
      ['measure_voltage.L1', { value: 240, at: now }],
    ]);
    expect(readingFrom(m, now)).toEqual({ t: now, w: [1200, 230, 230], total: 1500 });
    m.delete('measure_current.L3');
    expect(readingFrom(m, now)).toBeNull();
    expect(readingFrom(new Map([['measure_power', { value: 700, at: now }]]), now)).toEqual({ t: now, w: [700, 0, 0], total: 700 });
    expect(readingFrom(new Map([['measure_power', { value: 700, at: now - 10 * MIN }]]), now)).toBeNull();
    // A phase that has not changed keeps its value for a while; the total must be fresh.
    const held = new Map([
      ['measure_power', { value: 700, at: now }],
      ['measure_current.L1', { value: 2, at: now - 10 * MIN }],
      ['measure_current.L2', { value: 1, at: now }],
      ['measure_current.L3', { value: 1, at: now - 20 * MIN }],
    ]);
    expect(readingFrom(held, now)?.w).toEqual([460, 230, 230]);
    const latest = latestFromDevice({ id: 'x', capabilitiesObj: { measure_power: { value: 900, lastUpdated: new Date(now).toISOString() }, measure_current: { value: 'x' } } }, now);
    expect(latest.get('measure_power')).toEqual({ value: 900, at: now });
  });
});

describe('references and prices', () => {
  test('tracks on-intervals of metered devices, skipping meters and its own devices', () => {
    const tr = new ReferenceTracker();
    const dev = (power: number) => [
      { id: 'hp', name: 'Heatpump', class: 'heatpump', capabilities: ['measure_power'], capabilitiesObj: { measure_power: { value: power } } },
      { ...pulse, capabilitiesObj: { measure_power: { value: 3000 } } },
      { id: 'own', capabilities: ['measure_power'], capabilitiesObj: { measure_power: { value: 999 } } },
      { id: 'sun', class: 'solarpanel', capabilities: ['measure_power'], capabilitiesObj: { measure_power: { value: 999 } } },
      { id: 'inv', capabilities: ['measure_power', 'meter_power.exported'], capabilitiesObj: { measure_power: { value: 999 } } },
    ];
    [0, 0, 1300, 1300, 0, 1300].forEach((p, i) => tr.update(T0 + i * MIN, dev(p), new Set(['own'])));
    const refs = tr.references();
    expect(refs.map(r => r.id)).toEqual(['hp']);
    expect(refs[0].intervals).toEqual([{ start: T0 + 2 * MIN, end: T0 + 4 * MIN }, { start: T0 + 5 * MIN, end: T0 + 5 * MIN }]);
    expect(tr.heatPumpIds()).toEqual(['hp']);
    const back = ReferenceTracker.restore(JSON.parse(JSON.stringify(tr.snapshot())));
    expect(back.references()).toEqual(refs);
    expect(ReferenceTracker.restore('x').references()).toEqual([]);
    // Silence closes an open run at the last reading.
    tr.update(T0 + 60 * MIN, dev(0), new Set());
    expect(tr.references()[0].intervals[1]).toEqual({ start: T0 + 5 * MIN, end: T0 + 5 * MIN });
  });

  test('price book: hourly prices, flat fallback, average', () => {
    const b = new PriceBook();
    b.record(T0 + 10 * MIN, 2);
    b.record(T0 + 40 * MIN, 3); // quarter-hour prices: the hour is their mean
    b.record(T0 + 70 * MIN, 1);
    b.record(T0, NaN);
    expect(b.priceAt(null)(T0 + 30 * MIN)).toBe(2.5);
    expect(b.priceAt(1.5)(T0 + 5 * 3_600_000)).toBe(1.5);
    expect(b.average(T0, T0 + 2 * 3_600_000, null)).toBe(1.75);
    expect(b.average(0, 1, 9)).toBe(9);
    expect(PriceBook.restore(b.snapshot()).priceAt(null)(T0)).toBe(2.5);
  });
});

describe('analysis', () => {
  const floor = every(63, 21, 22);
  const hp = every(63, 4, 22, 40);
  const readings = synthHouse([{ w: [1330, 0, 0], on: floor }, { w: [330, 270, 250], on: hp }], 24 * 60 * MIN);
  const engine = new PowerEngine('UTC');
  readings.forEach(r => engine.push(r));
  const melcloud = hp.map(([a, b]) => ({ start: a + 2 * MIN, end: b + 3 * MIN }));
  const settings = { names: {}, experiments: [], currency: 'SEK', flatPrice: 2, cop: 3, timeZone: 'UTC' };

  test('names the heat pump from its device, finds the heater, ranks findings, scores the match', () => {
    const a = analyse(engine, [{ id: 'hp', name: 'Heatpump', intervals: melcloud }], ['hp'], new PriceBook(), settings, T0 + 24 * 60 * MIN);
    const pump = a.loads.find(l => l.phases === '3-phase')!;
    expect(pump.name).toBe('Heatpump');
    expect(pump.source).toBe('device');
    expect(a.validation[0].score.f1).toBeGreaterThan(0.9);
    const heater = a.loads.find(l => l.phases === 'L1')!;
    expect(heater.name).toBeNull();
    expect(displayName(heater)).toMatch(/W on L1$/);
    expect(a.findings[0].kind).toBe('rhythmic-heater');
    expect(a.days).toHaveLength(1);
    expect(a.avgPrice).toBe(2);
  });

  test('a finished test keeps its stored verdict; a stored rate is used', () => {
    const heaterId = engine.loads().find(l => l.phases === 'L1')!.id;
    const end = T0 + 24 * 60 * MIN;
    const stored = { status: 'confirmed' as const, expected: 4, observed: 0, pValue: 0.02, text: 'Confirmed' };
    const a = analyse(engine, [], [], new PriceBook(), {
      ...settings,
      experiments: [
        { id: 'a', loadId: heaterId, label: 'floor', startedAt: end - 4 * 3_600_000, hours: 3, result: stored },
        { id: 'b', loadId: heaterId, label: 'floor', startedAt: end - 4 * 3_600_000, hours: 3, rate: 0 },
      ],
    }, end);
    expect(a.experiments[0].status).toBe('confirmed');
    expect(a.loads.find(l => l.id === heaterId)!.source).toBe('test');
    expect(a.experiments[1].expected).toBe(0);
  });

  test('a user name wins; a passed switch-off test names the load', () => {
    const heaterId = engine.loads().find(l => l.phases === 'L1')!.id;
    const end = T0 + 24 * 60 * MIN;
    // Test starts 4 h before the end of the data, but the heater kept running: rejected.
    const a = analyse(engine, [], [], new PriceBook(), {
      ...settings,
      names: { [heaterId]: 'Kitchen floor' },
      experiments: [{ id: 'e', loadId: heaterId, label: 'the kitchen floor', startedAt: end - 4 * 3_600_000, hours: 3 }],
    }, end);
    expect(a.loads.find(l => l.id === heaterId)!.name).toBe('Kitchen floor');
    expect(a.experiments[0].status).toBe('rejected');
    expect(a.experiments[0].loadName).toBe('Kitchen floor');
  });

  test('a device on nearly all the time names nothing: every load falls inside it by chance', () => {
    const { clusterActivations } = jest.requireActual('../../src/engine/clustering');
    // Floor heater: 21 of every 63 min for two days. Spa: 15 of every 45 min, all day.
    const floor = Array.from({ length: 45 }, (_, i) => ({ start: T0 + i * 63 * MIN, end: T0 + (i * 63 + 21) * MIN, delta: [1330, 0, 0] as [number, number, number] }));
    const spaOn = Array.from({ length: 64 }, (_, i) => ({ start: T0 + (i * 45 + 10) * MIN, end: T0 + (i * 45 + 25) * MIN }));
    const m = nameFromDevices(clusterActivations(floor), [{ id: 'spa', name: 'BWA Spa', intervals: spaOn }]);
    expect(m).toEqual([]);
  });

  test('a modulating heat pump split into several loads: every part belongs to it, an independent load does not', () => {
    const { clusterActivations } = jest.requireActual('../../src/engine/clustering');
    const v = (a: number, b: number, c: number) => [a, b, c] as [number, number, number];
    const runs = Array.from({ length: 19 }, (_, i) => T0 + (i * 150 + 30) * MIN);
    const main = runs.map(s => ({ start: s, end: s + 60 * MIN, delta: v(200, 200, 200) }));
    // The compressor ramps up for 15 minutes in every fourth run: a second, shorter, rarer load.
    const boost = runs.filter((_, i) => i % 4 === 0).map(s => ({ start: s + 20 * MIN, end: s + 35 * MIN, delta: v(300, 300, 300) }));
    const floor = Array.from({ length: 45 }, (_, i) => ({ start: T0 + i * 63 * MIN, end: T0 + (i * 63 + 21) * MIN, delta: v(1330, 0, 0) }));
    const loads = clusterActivations([...main, ...boost, ...floor]);
    const melcloud = runs.map(s => ({ start: s + 3 * MIN, end: s + 63 * MIN }));
    const m = nameFromDevices(loads, [{ id: 'hp', name: 'Värmepump', intervals: melcloud }]);
    const named = new Set(m.flatMap(x => x.clusterIds));
    const idOf = (w: number) => loads.find((l: any) => Math.abs(l.medianW - w) < 50)!.id;
    expect(named.has(idOf(600))).toBe(true);
    expect(named.has(idOf(900))).toBe(true);
    expect(named.has(idOf(1330))).toBe(false);
    expect(m.every(x => x.referenceId === 'hp')).toBe(true);
  });

  test('two metered devices of a size on one phase: their runs count once, by their own meters', () => {
    // A spa heater and a space heater on L2, close enough in size to be one load; floor heating on L1.
    const spa = every(240, 40, 6, 10);
    const heater = every(240, 60, 6, 130);
    const floorOn = every(63, 21, 22);
    const house = synthHouse(
      [{ w: [0, 2600, 0], on: spa }, { w: [0, 2000, 0], on: heater }, { w: [1330, 0, 0], on: floorOn }],
      24 * 60 * MIN
    );
    const eng = new PowerEngine('UTC');
    house.forEach(r => eng.push(r));
    const date = '2026-10-21';
    const kWh = (on: Array<[number, number]>, w: number) => on.reduce((s, [a, b]) => s + (w * (b - a)) / 3.6e9, 0);
    const device = (id: string, name: string, share: [number, number, number], days: Record<string, number>) => ({
      id, name, w: 0, at: T0, counter: null, hasCounter: true, live: false, days,
      outcomes: [0, 1, 2].map(() => ({ hit: true, share, lagMs: 0 })),
    });
    const metered = MeteredDevices.restore({
      version: 1,
      devices: [
        device('spa', 'BWA Spa', [0, 1, 0], { [date]: kWh(spa, 2600) }),
        device('heater', 'Space heater', [0, 1, 0], { [date]: kWh(heater, 2000) }),
      ],
    }, 'UTC');
    const refs = [
      { id: 'spa', name: 'BWA Spa', intervals: spa.map(([start, end]) => ({ start, end })) },
      { id: 'heater', name: 'Space heater', intervals: heater.map(([start, end]) => ({ start, end })) },
    ];
    const a = analyse(eng, refs, [], new PriceBook(), settings, T0 + 24 * 60 * MIN, { metered });

    const l2 = a.loads.filter(l => l.phases === 'L2');
    expect(l2.length).toBeGreaterThan(0);
    l2.forEach(l => expect(l.source).toBe('device'));
    const floor = a.loads.find(l => l.phases === 'L1')!;
    expect(floor.name).toBeNull();

    const day = a.accounts.find(d => d.date === date)!;
    expect(day.overlapKWh).toBeLessThan(0.1);
    const loadRows = day.rows.filter(r => r.kind === 'load');
    expect(loadRows).toHaveLength(1);
    expect(Math.abs(loadRows[0].kWh - kWh(floorOn, 1330)) / kWh(floorOn, 1330)).toBeLessThan(0.15);
  });

  test('a heat pump whose reports miss its short runs keeps its name once it had one; silence is not "off"', () => {
    const { clusterActivations } = jest.requireActual('../../src/engine/clustering');
    const v = (a: number, b: number, c: number) => [a, b, c] as [number, number, number];
    // 40 compressor runs of 4 min, one every 30 min. MELCloud polls every 5 min: it reports 26.
    const starts = Array.from({ length: 40 }, (_, i) => T0 + i * 30 * MIN);
    const loads = clusterActivations(starts.map(s => ({ start: s, end: s + 4 * MIN, delta: v(250, 250, 250) })));
    const reported = starts.filter((_, i) => i % 3 !== 2).map(s => ({ start: s + 3 * MIN, end: s + 8 * MIN }));
    const ref = { id: 'hp', name: 'Heatpump', intervals: reported };
    expect(nameFromDevices(loads, [ref])).toEqual([]); // precision 0.65: not enough to name it
    const kept = nameFromDevices(loads, [ref], { [loads[0].id]: 'hp' });
    expect(kept.map(m => m.referenceName)).toEqual(['Heatpump']); // enough to keep it

    // Reports stop for the last 8 hours while the compressor runs on: no run there counts against it.
    const quiet = reported.filter(i => i.start < T0 + 12 * 60 * MIN);
    const silent = silentStretches(quiet, T0 + 20 * 60 * MIN);
    expect(silent).toHaveLength(1);
    expect(silent[0].end).toBe(T0 + 20 * 60 * MIN);
    const keep = { [loads[0].id]: 'hp' };
    expect(nameFromDevices(loads, [{ ...ref, intervals: quiet }], keep)).toEqual([]); // silence read as "off": 16 misses
    const withSilence = nameFromDevices(loads, [{ ...ref, intervals: quiet, silent }], keep);
    expect(withSilence.map(m => m.referenceName)).toEqual(['Heatpump']);
    expect(withSilence[0].score.fp).toBeLessThanOrEqual(9); // only the runs MELCloud missed while reporting
    // A device used once a day is not silent between uses.
    expect(silentStretches(Array.from({ length: 10 }, (_, d) => ({ start: T0 + d * 86_400_000, end: T0 + d * 86_400_000 + 60 * MIN })), T0 + 10 * 86_400_000)).toEqual([]);
  });

  test('a run is a metered device only on its phases and at its switch-on', () => {
    const v = (a: number, b: number, c: number) => [a, b, c] as [number, number, number];
    const shares = new Map([['hp', v(0.4, 0.3, 0.3)], ['spa', v(0, 1, 0)]]);
    const runOf = meteredRunOf(
      [
        { id: 'hp', name: 'Heatpump', intervals: [{ start: T0, end: T0 + 10 * MIN }] },
        { id: 'spa', name: 'BWA Spa', intervals: [{ start: T0, end: T0 + 40 * MIN }] },
        { id: 'plug', name: 'Not learned', intervals: [{ start: T0, end: T0 + 40 * MIN }] },
      ],
      shares
    );
    const run = (start: number, delta: [number, number, number]) => ({ start, end: start + 20 * MIN, delta });
    expect(runOf(run(T0 + MIN, v(1330, 0, 0)))).toBeNull(); // the heat pump's start, but L1 only
    expect(runOf(run(T0 + MIN, v(240, 180, 180)))).toBe('hp');
    expect(runOf(run(T0 + 2 * MIN, v(0, 2600, 0)))).toBe('spa');
    expect(runOf(run(T0 + 30 * MIN, v(0, 2600, 0)))).toBeNull(); // on L2, but not when the spa switched on
  });

  test('programme mode: a plug-metered appliance whose heater is a part of the run', () => {
    const dishAct = [0, 1, 2, 3, 4].flatMap(d => [
      { start: T0 + d * 86_400_000, end: T0 + d * 86_400_000 + 8 * MIN, delta: [0, 0, 2900] as [number, number, number] },
      { start: T0 + d * 86_400_000 + 45 * MIN, end: T0 + d * 86_400_000 + 53 * MIN, delta: [0, 0, 2900] as [number, number, number] },
    ]);
    const { clusterActivations } = jest.requireActual('../../src/engine/clustering');
    const loads = clusterActivations(dishAct);
    const plug = [0, 1, 2, 3, 4].map(d => ({ start: T0 + d * 86_400_000 - 2 * MIN, end: T0 + d * 86_400_000 + 90 * MIN }));
    const m = nameFromDevices(loads, [{ id: 'dw', name: 'Dishwasher plug', intervals: plug }]);
    expect(m).toHaveLength(1);
    expect(m[0].score.f1).toBe(1);
  });
});
