/**
 * System test of the rethink: use what the house already meters, and account for every kWh.
 *
 *   Pulse ──> learn each metered device's phases and delay ──> subtract the fast ones live
 *         └─> house meter per day ─────────────┐
 *   device meters ──> kWh per device per day ──┼──> energy account (adds up to the meter)
 *   residual ──> found loads, always-on ───────┤
 *   outdoor temperature ──> heating estimate ──┘
 *
 * The house (meteredHouse) keeps the truth: what each load and each device's meter used.
 */
jest.mock('homey-api', () => require('./harness').homeyApiMock);

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { asIntervals, matchIntervals } from '../../src/engine/score';
import { DAY_TEMPS, FakeHomey, HOUR, MIN, START, Sim, boot, meteredDevices, meteredHouse } from './harness';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-account-'));
process.env.POWER_DETECTIVE_STATE = path.join(tmp, 'state.json');

const api = require('../../api');
const widget = require('../../widgets/now/api.js');

const homey = new FakeHomey();
const house = meteredHouse();
const sim = new Sim(house, homey);
const ctx = (body?: unknown) => ({ homey, body });
let app: any;
let learnedAt = 0;

const close = (a: number, b: number, rel: number) => Math.abs(a - b) <= rel * Math.max(Math.abs(b), 1e-9);
const fullDays = (view: any) => view.accounts.filter((d: any) => d.coveredHours >= 23);
const rowOf = (day: any, key: string) => day.rows.find((r: any) => r.key === key);
const evW = 3 * 3680;

beforeAll(() => {
  meteredDevices();
  jest.spyOn(Date, 'now').mockImplementation(() => homey.now);
});
afterAll(async () => {
  await app?.onUninit();
  jest.restoreAllMocks();
});

test('metered devices are learned from the Pulse: the fast ones subtracted live, MELCloud energy only, solar never', async () => {
  app = await boot(homey);
  await sim.advance(36 * HOUR);
  const view = await api.getState(ctx());
  const st = (id: string) => view.metered.find((m: any) => m.id === id);
  expect(st('easee')).toMatchObject({ name: 'Easee ladder', live: true });
  st('easee').share.forEach((x: number) => expect(x).toBeCloseTo(1 / 3, 1));
  expect(st('spa')).toMatchObject({ name: 'BWA Spa', live: true });
  expect(st('spa').share[1]).toBeGreaterThan(0.85);
  expect(st('hp')).toMatchObject({ name: 'Värmepump', live: false });
  expect(st('hp').lagMs).toBeGreaterThan(2 * MIN);
  expect(st('inverter')).toBeUndefined();
  learnedAt = homey.now;
}, 120_000);

test('once learned, the charger and the spa no longer reach detection', async () => {
  await sim.advance(24 * HOUR);
  const big = app.engine
    .allActivations()
    .filter((a: any) => a.start > learnedAt)
    .filter((a: any) => {
      const w = a.delta[0] + a.delta[1] + a.delta[2];
      const spaLike = Math.abs(a.delta[1] - 3000) < 300 && a.delta[0] < 300 && a.delta[2] < 300;
      return w > 6000 || spaLike;
    });
  expect(big).toEqual([]);
}, 120_000);

test('the floor heater is found every time, also while the car charges', async () => {
  const cluster = app.analysis.clusters.find((c: any) => c.phases === 'L1' && Math.abs(c.medianW - 1330) < 80);
  expect(cluster).toBeDefined();
  const truth = house.truth('floor', learnedAt, homey.now).filter(r => r.end < homey.now);
  const duringEv = truth.filter(r => house.loadW('ev', r.start) > 0 || house.loadW('ev', r.end) > 0);
  expect(duringEv.length).toBeGreaterThanOrEqual(3);
  const detected = asIntervals(cluster.activations.filter((a: any) => a.start >= learnedAt));
  expect(matchIntervals(duringEv, detected, 2 * MIN).recall).toBe(1);
  expect(matchIntervals(truth, detected, 2 * MIN).recall).toBeGreaterThanOrEqual(0.95);
}, 60_000);

test('the energy account adds up to the house meter, with exact device meters and nothing counted twice', async () => {
  const view = await api.getState(ctx());
  const days = fullDays(view);
  expect(days.length).toBeGreaterThanOrEqual(2);
  let floorFound = 0;
  let floorTrue = 0;
  for (const day of days) {
    const sum = day.rows.reduce((s: number, r: any) => s + r.kWh, 0);
    expect(close(sum, day.totalKWh, 1e-9)).toBe(true);
    expect(close(day.totalKWh, sim.truthKWh(day.date, 'house'), 0.02)).toBe(true);
    // Each device's row is its own meter's energy.
    expect(close(rowOf(day, 'device:easee').kWh, sim.truthKWh(day.date, 'device:easee'), 0.02)).toBe(true);
    expect(close(rowOf(day, 'device:spa').kWh, sim.truthKWh(day.date, 'device:spa'), 0.03)).toBe(true);
    expect(close(rowOf(day, 'device:hp').kWh, sim.truthKWh(day.date, 'device:hp'), 0.03)).toBe(true);
    expect(rowOf(day, 'device:inverter')).toBeUndefined();
    // The heat pump's runs found on the house meter are not a second heat pump row.
    const loads = day.rows.filter((r: any) => r.kind === 'load');
    expect(loads.some((r: any) => r.name === 'Värmepump')).toBe(false);
    // Found loads are only what nothing meters: no heat pump energy counted a second time.
    const unmetered = ['floor', 'kettle', 'oven'].reduce((x, k) => x + sim.truthKWh(day.date, k), 0);
    expect(loads.reduce((x: number, r: any) => x + r.kWh, 0)).toBeLessThan(unmetered * 1.15);
    // The floor heater, found unaided, about its true energy.
    const floor = loads.find((r: any) => /^1[,.]?3\d0 W on L1$/.test(r.name));
    expect(floor).toBeDefined();
    // One missed stop (a switch-off hidden by a heat pump step) can cost a day up to 15 %.
    expect(close(floor.kWh, sim.truthKWh(day.date, 'floor'), 0.15)).toBe(true);
    floorFound += floor.kWh;
    floorTrue += sim.truthKWh(day.date, 'floor');
    // Most of the day is accounted for: meters, found loads and always-on.
    expect(day.explainedShare).toBeGreaterThan(0.8);
  }
  // Over the days together, the floor heater's energy is close. Measured: 5.8 % low over the first
  // two days, all from one missed stop on day 1 (hidden by a heat pump step) that swallowed two runs.
  expect(close(floorFound, floorTrue, 0.07)).toBe(true);
}, 60_000);

test('the widget shows metered devices by name while they run', async () => {
  await sim.until(() => house.loadW('ev', homey.now) > 0 && house.loadW('ev', homey.now - 2 * MIN) > 0, 24 * HOUR);
  const w = await widget.getNow({ homey });
  const ev = w.running.find((r: any) => r.name === 'Easee ladder');
  expect(ev).toMatchObject({ metered: true });
  expect(Math.abs(ev.w - evW)).toBeLessThan(100);
  expect(Math.abs(w.totalW - house.power(homey.now).total)).toBeLessThan(40);
  expect(w.today.explainedShare).toBeGreaterThan(0);
  expect(w.today.kWh).toBeGreaterThan(0);
}, 60_000);

test('the widget lists a device once: a found load named after a running metered device is that device', async () => {
  await sim.until(() => house.loadW('heatpump', homey.now - 4 * MIN) > 0 && house.loadW('heatpump', homey.now) > 0, 6 * HOUR);
  await sim.advance(10 * MIN);
  const w = await widget.getNow({ homey });
  const names = w.running.map((r: any) => r.name).filter(Boolean);
  expect(names.filter((n: string) => n === 'Värmepump')).toHaveLength(1);
  expect(new Set(names).size).toBe(names.length);
}, 60_000);

test('the widget shows no stale runs: once the heat pump is off, none of its parts is listed', async () => {
  await sim.until(() => [0, 5, 10, 15].every(m => house.loadW('heatpump', homey.now - m * MIN) === 0), 4 * HOUR);
  await sim.advance(5 * MIN);
  const w = await widget.getNow({ homey });
  expect(w.running.filter((r: any) => r.name === 'Värmepump')).toEqual([]);
}, 60_000);

test('what was learned survives a restart', async () => {
  await app.onUninit();
  homey.stopAll();
  sim.forgetEmitted();
  app = await boot(homey);
  const view = await api.getState(ctx());
  expect(view.metered.find((m: any) => m.id === 'easee')).toMatchObject({ live: true });
  expect(fullDays(view).length).toBeGreaterThanOrEqual(2);
}, 60_000);

test('after a week and more: heating estimated from outdoor temperature, colder days more', async () => {
  await sim.until(() => homey.now >= START + 9 * 24 * HOUR + HOUR, 7 * 24 * HOUR);
  const view = await api.getState(ctx());
  expect(view.heating).not.toBeNull();
  expect(view.heating.slope).toBeGreaterThan(0);
  const days = fullDays(view);
  const weather = days.map((d: any) => ({ temp: DAY_TEMPS[Math.round((Date.parse(d.date) - START) / (24 * HOUR)) + 0], kWh: rowOf(d, 'weather')?.kWh ?? 0 }));
  expect(weather.filter((w: any) => w.kWh > 0).length).toBeGreaterThanOrEqual(4);
  // Colder days carry more weather heating (rank correlation of temperature and kWh is negative).
  const coldest = weather.reduce((a: any, b: any) => (b.temp < a.temp ? b : a));
  const mildest = weather.reduce((a: any, b: any) => (b.temp > a.temp ? b : a));
  expect(coldest.kWh).toBeGreaterThan(mildest.kWh);
  // Findings agree with the account: the base-load finding is about the true always-on power,
  // not the winter heating that runs all day, and the floor heater's kWh/day is about its truth.
  const lastFull = days[days.length - 1];
  const base = view.findings.find((f: any) => f.kind === 'base-load');
  if (base) expect(Math.abs(Number(/(\d+) W/.exec(base.title)![1]) - lastFull.alwaysOnW)).toBeLessThan(40);
  const floorLoad = view.loads.find((l: any) => l.phases === 'L1' && Math.abs(l.medianW - 1330) < 80);
  expect(close(floorLoad.kWhPerDay, (1330 * 21) / 60 / 1000 * (1440 / 63), 0.1)).toBe(true);
  for (const day of days.slice(-5)) {
    const sum = day.rows.reduce((s: number, r: any) => s + r.kWh, 0);
    expect(close(sum, day.totalKWh, 1e-9)).toBe(true);
    // The heating estimate is the radiators' energy, and always-on is the true base (410 W).
    expect(close(rowOf(day, 'weather').kWh, sim.truthKWh(day.date, 'radiators'), 0.15)).toBe(true);
    expect(close(rowOf(day, 'always_on').kWh, (410 * 24) / 1000, 0.15)).toBe(true);
  }
}, 300_000);
