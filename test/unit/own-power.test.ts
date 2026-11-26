/**
 * A device's own power for the live view: its reading while fresh, else its energy counter's rate.
 * MELCloud on 2026-11-25: measure_power frozen at 1002 W while the counter rose 0.101 kWh per 5 min.
 * On 2026-11-26 06:43 the level tracker said 4.8 kW of heat pump with cooking on all three phases;
 * MELCloud said 1156 W.
 */
import { MeteredDevices } from '../../src/homey/metered';
import { fitLive } from '../../src/homey/live';
import { Vec3 } from '../../src/engine/types';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 25, 20, 44);
const HP = 'hp';

describe('a device\'s own power', () => {
  test('a fresh reading is its power', () => {
    const m = new MeteredDevices('Europe/Stockholm');
    m.power(HP, 'Heatpump', 1156, T0);
    expect(m.ownPower(HP, T0 + 5 * MIN)).toMatchObject({ w: 1156, from: 'power' });
  });

  test('a frozen reading: the counter\'s rate instead (polled each minute)', () => {
    const m = new MeteredDevices('Europe/Stockholm');
    m.power(HP, 'Heatpump', 1002, T0);
    let kWh = 540;
    for (let i = 0; i <= 60; i++) {
      if (i % 5 === 0 && i > 0) kWh += 0.101;
      m.counter(HP, kWh, T0 + i * MIN);
    }
    const own = m.ownPower(HP, T0 + 60 * MIN);
    expect(own?.from).toBe('counter');
    expect(own!.w).toBeGreaterThan(1150);
    expect(own!.w).toBeLessThan(1260);
  });

  test('neither usable: null (the level tracker then estimates)', () => {
    const m = new MeteredDevices('Europe/Stockholm');
    m.power(HP, 'Heatpump', 1002, T0);
    m.counter(HP, 540, T0);
    m.counter(HP, 540.1, T0 + 5 * MIN);
    m.counter(HP, 540.2, T0 + 10 * MIN);
    expect(m.ownPower(HP, T0 + 60 * MIN)).toBeNull();
    expect(m.ownPower('unknown', T0)).toBeNull();
  });

  test('the live view takes it by its phase share; cooking stays out of it', () => {
    const live = fitLive({
      now: T0,
      phaseW: [3289, 1472, 2162] as Vec3,
      baseW: 165,
      heatPump: { w: 1156, since: T0 - 60 * MIN, name: 'Heatpump', named: true, share: [0.45, 0.45, 0.1] as Vec3 },
      starts: [],
      loads: [],
      heatPumpLoadIds: [],
    });
    const hp = live.rows.find(r => r.heatPump)!;
    expect(hp.w).toBe(1156);
    expect(live.restW[2]).toBeGreaterThan(1800); // the hob's L3 stays unexplained, not heat pump
  });
});
