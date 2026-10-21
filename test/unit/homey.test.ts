import { analyse, displayName, nameFromDevices } from '../../src/homey/analysis';
import { latestFromDevice, meterCandidates, pickMeter, readingFrom } from '../../src/homey/meter';
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
