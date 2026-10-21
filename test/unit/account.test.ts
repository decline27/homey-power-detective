/**
 * The energy account: every kWh the house meter counted, in exactly one row.
 *
 *   house meter total = metered devices (exact) + always-on + found loads
 *                     + heating estimated from outdoor temperature + unexplained
 */
import { AccountInput, buildAccount } from '../../src/insight/account';

const input = (over: Partial<AccountInput> = {}): AccountInput => ({
  date: '2026-10-06',
  totalKWh: 40,
  coveredHours: 24,
  metered: [
    { id: 'easee', name: 'Easee ladder', kWh: 12 },
    { id: 'hp', name: 'Värmepump', kWh: 8 },
  ],
  alwaysOnKWh: 6,
  alwaysOnW: 250,
  loads: [
    { loadId: 'L1-133', name: 'Kitchen floor', kWh: 9, deviceId: null },
    { loadId: '3-phase-93', name: 'Värmepump', kWh: 7.5, deviceId: 'hp' },
  ],
  weatherKWh: null,
  ...over,
});

const sum = (rows: Array<{ kWh: number }>) => rows.reduce((s, r) => s + r.kWh, 0);
const row = (a: ReturnType<typeof buildAccount>, key: string) => a.rows.find(r => r.key === key);
/** kWh of a row; an empty row is left out of the account, so absent means 0. */
const kwh = (a: ReturnType<typeof buildAccount>, key: string) => row(a, key)?.kWh ?? 0;

describe('energy account', () => {
  test('rows add up to the house meter, shares to 1', () => {
    const a = buildAccount(input());
    expect(sum(a.rows)).toBeCloseTo(40, 9);
    expect(a.rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(1, 9);
    expect(a.rows.every(r => r.kWh >= 0)).toBe(true);
  });

  test('metered devices are exact and come first; a found load matched to one is not counted again', () => {
    const a = buildAccount(input());
    expect(row(a, 'device:easee')).toMatchObject({ kind: 'metered', kWh: 12, exact: true, name: 'Easee ladder' });
    expect(row(a, 'device:hp')).toMatchObject({ kind: 'metered', kWh: 8, exact: true });
    // The heat pump's runs found on the house meter are the same energy as its own meter.
    expect(row(a, 'load:3-phase-93')).toBeUndefined();
    expect(row(a, 'load:L1-133')).toMatchObject({ kind: 'load', kWh: 9, exact: false });
    expect(row(a, 'always_on')).toMatchObject({ kWh: 6, exact: false });
    expect(row(a, 'unexplained')!.kWh).toBeCloseTo(40 - 12 - 8 - 6 - 9, 9);
    expect(a.explainedShare).toBeCloseTo((12 + 8 + 6 + 9) / 40, 9);
    expect(a.overlapKWh).toBe(0);
  });

  test('a found load matched to a device that is not metered by energy stays a load', () => {
    const a = buildAccount(input({ metered: [{ id: 'easee', name: 'Easee ladder', kWh: 12 }] }));
    expect(row(a, 'load:3-phase-93')).toMatchObject({ kind: 'load', kWh: 7.5 });
  });

  test('heating from outdoor temperature: first what is unexplained, then what looked always-on', () => {
    const some = buildAccount(input({ weatherKWh: 3 }));
    expect(row(some, 'weather')).toMatchObject({ kind: 'weather', kWh: 3, exact: false });
    expect(kwh(some, 'unexplained')).toBeCloseTo(5 - 3, 9);
    expect(kwh(some, 'always_on')).toBe(6);
    // Radiators running all day in the cold look like always-on power; the weather says otherwise.
    const more = buildAccount(input({ weatherKWh: 8 }));
    expect(kwh(more, 'weather')).toBeCloseTo(8, 9);
    expect(row(more, 'unexplained')).toBeUndefined();
    expect(kwh(more, 'always_on')).toBeCloseTo(3, 9);
    // The always-on power shown with it is what is left of it: 3 kWh over 24 h.
    expect(more.alwaysOnW).toBeCloseTo(125, 9);
    expect(some.alwaysOnW).toBe(250);
    // Never more than both together; meters and found loads are never touched.
    const tooMuch = buildAccount(input({ weatherKWh: 30 }));
    expect(kwh(tooMuch, 'weather')).toBeCloseTo(11, 9);
    expect(row(tooMuch, 'always_on')).toBeUndefined();
    expect(kwh(tooMuch, 'load:L1-133')).toBe(9);
    expect(sum(tooMuch.rows)).toBeCloseTo(40, 9);
  });

  test('when the parts exceed the meter, estimates give way before exact meters, and the excess is reported', () => {
    // Estimates first: loads, then always-on, shrink to fit.
    const a = buildAccount(input({ totalKWh: 30 }));
    expect(sum(a.rows)).toBeCloseTo(30, 9);
    expect(row(a, 'device:easee')!.kWh).toBe(12);
    expect(row(a, 'device:hp')!.kWh).toBe(8);
    expect(row(a, 'always_on')!.kWh).toBe(6);
    expect(row(a, 'load:L1-133')!.kWh).toBeCloseTo(4, 9);
    expect(a.overlapKWh).toBeCloseTo(5, 9);
    expect(kwh(a, 'unexplained')).toBe(0);

    // Meters alone beyond the house total (a meter outage): meters scale, nothing negative.
    const b = buildAccount(input({ totalKWh: 10 }));
    expect(sum(b.rows)).toBeCloseTo(10, 9);
    expect(row(b, 'device:easee')!.kWh).toBeCloseTo(6, 9);
    expect(row(b, 'device:hp')!.kWh).toBeCloseTo(4, 9);
    expect(b.rows.every(r => r.kWh >= 0)).toBe(true);
    expect(b.overlapKWh).toBeCloseTo(25, 9);
  });

  test('rows are ordered: meters, loads (largest first), always-on, heating, unexplained; empty rows dropped', () => {
    const a = buildAccount(input({
      loads: [
        { loadId: 'small', name: 'Kettle', kWh: 1, deviceId: null },
        { loadId: 'big', name: 'Floor', kWh: 5, deviceId: null },
        { loadId: 'none', name: 'Nothing', kWh: 0, deviceId: null },
      ],
      weatherKWh: 2,
    }));
    expect(a.rows.map(r => r.key)).toEqual(['device:easee', 'device:hp', 'load:big', 'load:small', 'always_on', 'weather', 'unexplained']);
  });

  test('an empty day is an empty account', () => {
    const a = buildAccount(input({ totalKWh: 0, metered: [], loads: [], alwaysOnKWh: 0 }));
    expect(a.rows).toEqual([]);
    expect(a.explainedShare).toBe(0);
  });
});
