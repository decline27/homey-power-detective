import { LIVE, LiveLoad, fitLive } from '../../src/homey/live';
import { LoadCluster, StepEvent, Vec3 } from '../../src/engine/types';

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 25, 21, 25);
const start = (minAgo: number, delta: Vec3): StepEvent => ({ t: NOW - minAgo * MIN, settledAt: NOW - minAgo * MIN, delta });
const cluster = (id: string) => ({ id } as unknown as LoadCluster);
const load = (id: string, extra: Partial<LiveLoad> = {}): LiveLoad => ({ id, name: null, suggestion: null, phases: 'L2', medianW: 2006, ...extra });
const sum = (v: Vec3) => v[0] + v[1] + v[2];

describe('live view fitted to the meter', () => {
  // The Homey on 2026-11-25 22:25: phases 943/2530/437 W, MELCloud said 1002 W; the open starts were
  // a 2330 W 3-phase step (59 min), 920 W on L3 (183 min) and a 2 kW L2 load (6 min).
  const homey = {
    now: NOW,
    phaseW: [943, 2530, 437] as Vec3,
    baseW: 100,
    heatPump: { w: 1011, since: NOW - 59 * MIN, name: 'Heatpump', named: true },
    starts: [
      { start: start(59, [777, 777, 777]), cluster: null },
      { start: start(183, [0, 0, 920]), cluster: null },
      { start: start(6, [0, 1818, 0]), cluster: cluster('L2-79') },
    ],
    loads: [load('L2-79')],
    heatPumpLoadIds: [] as string[],
  };

  test('never more than the meter, and no phase more than it draws', () => {
    const live = fitLive(homey);
    expect(live.rows.reduce((n, r) => n + r.w, 0)).toBeLessThanOrEqual(live.totalW);
    expect(live.restW.every(w => w >= 0)).toBe(true);
    expect(live.totalW).toBe(3910);
  });

  test('the heat pump from the level tracker; its own 3-phase step is not a second row', () => {
    const rows = fitLive(homey).rows;
    expect(rows.find(r => r.heatPump)).toMatchObject({ name: 'Heatpump', w: 1011, phases: '3-phase' });
    expect(rows.filter(r => r.phases === '3-phase')).toHaveLength(1);
  });

  test('a stale start its phase cannot carry is not shown; the new L2 load is', () => {
    const rows = fitLive(homey).rows;
    expect(rows.map(r => r.name)).toEqual(['2010 W on L2', 'Heatpump']);
    expect(rows[0].w).toBe(1818);
  });

  test('a start only partly carried is shown at what its phase carries', () => {
    const live = fitLive({ ...homey, heatPump: null, phaseW: [100, 1400, 100], starts: [{ start: start(6, [0, 1818, 0]), cluster: cluster('L2-79') }] });
    expect(live.rows[0].w).toBe(1300);
    expect(1300 / 1818).toBeGreaterThanOrEqual(LIVE.FIT_MIN);
  });

  test('without the heat pump on, an even 3-phase start is fitted like any other', () => {
    const live = fitLive({ ...homey, heatPump: null, phaseW: [900, 900, 900], starts: [{ start: start(20, [777, 777, 777]), cluster: null }] });
    expect(live.rows).toHaveLength(1);
    expect(live.rows[0].w).toBe(2331);
  });

  test('names: a user name, else the suggestion, else size and phase; parts of one load are one row', () => {
    const loads = [load('a', { name: 'Kettle', phases: 'L3', medianW: 1900 }), load('b', { suggestion: 'Oven', phases: 'L1', medianW: 1800 })];
    const live = fitLive({ ...homey, heatPump: null, phaseW: [2000, 100, 4000], loads,
      starts: [
        { start: start(2, [0, 0, 1900]), cluster: cluster('a') },
        { start: start(1, [0, 0, 1900]), cluster: cluster('a') },
        { start: start(3, [1800, 0, 0]), cluster: cluster('b') },
      ] });
    expect(live.rows.map(r => [r.name, r.w, r.named])).toEqual([['Kettle', 3800, true], ['Oven (likely)', 1800, false]]);
  });

  test('the rest keeps the base and what nothing explains', () => {
    const live = fitLive({ ...homey, heatPump: null, starts: [] });
    expect(sum(live.restW)).toBe(live.totalW);
  });
});
