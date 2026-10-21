/**
 * System test: a week in the reference house, through the app's own timers and public surfaces.
 * Each step builds on the one before, the way a user meets the app:
 *
 *   install ─> 2 days learning ─> flows ─> name a load ─> widget ─> pair a device
 *           ─> switch-off tests ─> Homey restarts ─> a week passes (summary)
 *
 * The judge is the simulated house's ground truth, never the app's own numbers.
 */
jest.mock('homey-api', () => require('./harness').homeyApiMock);

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { asIntervals, matchIntervals } from '../../src/engine/score';
import { FakeHomey, HOUR, MIN, START, Sim, boot, pair, referenceHouse, standardDevices, world } from './harness';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-system-'));
process.env.POWER_DETECTIVE_STATE = path.join(tmp, 'state.json');

const api = require('../../api');
const widget = require('../../widgets/now/api.js');

const homey = new FakeHomey();
const house = referenceHouse();
const sim = new Sim(house, homey);
const ctx = (body?: unknown) => ({ homey, body });
let app: any;
let floor: any;
let hp: any;
let floorDevice: any;

/** Expected from the schedule: 1330 W for 21 of every 63 min. */
const FLOOR_KWH_PER_RUN = (1330 * 21) / 60 / 1000;
const FLOOR_KWH_PER_DAY = FLOOR_KWH_PER_RUN * (1440 / 63);

/**
 * How well the app's runs of a load match the house's true runs (a judge-only look inside).
 * `clean` leaves out the runs no house-meter method can see apart: those switching within 30 s
 * of another load's switching, and a run already on when the app started.
 */
function judge(key: string, loadId: string, from: number, to: number) {
  const cluster = app.analysis.clusters.find((c: any) => c.id === loadId);
  const detected = asIntervals((cluster?.activations ?? []).filter((a: any) => a.start >= from && a.end <= to));
  const truth = house.truth(key, from, to).filter(r => r.end < to);
  const edges = house.loads
    .filter(l => l.key !== key)
    .flatMap(l => house.truth(l.key, from - HOUR, to + HOUR))
    .flatMap(r => [r.start, r.end]);
  const near = (t: number) => edges.some(e => Math.abs(e - t) <= 30_000);
  const clean = truth.filter(r => r.start > START && !near(r.start) && !near(r.end));
  return { all: matchIntervals(truth, detected, 2 * MIN), clean: matchIntervals(clean, detected, 2 * MIN), cleanRuns: clean.length };
}

const lastFullDay = (view: any) => [...view.days].reverse().find((d: any) => d.coveredHours >= 23);

beforeAll(() => {
  standardDevices();
  jest.spyOn(Date, 'now').mockImplementation(() => homey.now);
});
afterAll(() => jest.restoreAllMocks());

test('two days in the house: finds the loads it was never told about, from the Pulse alone', async () => {
  app = await boot(homey);
  expect(app.widgetState().status).toBe('Listening to Pulse');

  await sim.advance(48 * HOUR);
  const view = await api.getState(ctx());

  // The floor heater: no device meters it; found, sized and timed from the house meter.
  floor = view.loads.find((l: any) => l.phases === 'L1' && Math.abs(l.medianW - 1330) < 80);
  expect(floor).toBeDefined();
  expect(floor.rhythmic).toBe(true);
  expect(floor.periodMinutes).toBeGreaterThan(60);
  expect(floor.periodMinutes).toBeLessThan(66);
  expect(Math.abs(floor.medianMinutes - 21)).toBeLessThan(2);
  expect(floor.kWhPerDay / FLOOR_KWH_PER_DAY).toBeGreaterThan(0.9);
  expect(floor.kWhPerDay / FLOOR_KWH_PER_DAY).toBeLessThan(1.1);
  const floorScore = judge('floor', floor.id, START, homey.now);
  expect(floorScore.cleanRuns).toBeGreaterThan(35);
  expect(floorScore.clean.recall).toBe(1);
  expect(floorScore.all.f1).toBeGreaterThanOrEqual(0.95);

  // The heat pump: found on all phases and named from its own metered device.
  hp = view.loads.find((l: any) => l.phases === '3-phase' && Math.abs(l.medianW - 930) < 80);
  expect(hp).toMatchObject({ source: 'device', device: 'Värmepump', name: 'Värmepump' });
  const hpScore = judge('heatpump', hp.id, START, homey.now);
  expect(hpScore.clean.recall).toBe(1);
  expect(hpScore.all.precision).toBeGreaterThanOrEqual(0.9);
  // Simultaneous switching costs a few runs' timing; the known weak spot, bounded here.
  expect(hpScore.all.f1).toBeGreaterThanOrEqual(0.85);
  // The app's own live check against the device agrees with the judge.
  const hpCheck = view.validation.find((v: any) => v.device === 'Värmepump');
  expect(Math.abs(hpCheck.score.f1 - hpScore.all.f1)).toBeLessThan(0.06);
  // The solar inverter measures power but is not a load.
  expect(view.validation.some((v: any) => v.device === 'Solceller')).toBe(false);

  // Money: the hourly price mean from the Tibber home device (2 h at 3.2, 3 h at 3.6, 19 h at 1.4).
  expect(view.avgPrice).toBeCloseTo((2 * 3.2 + 3 * 3.6 + 19 * 1.4) / 24, 1);
  // The ledger: base load and how much of the day the found loads explain.
  const day = lastFullDay(view);
  expect(Math.abs(day.baseloadW - 410)).toBeLessThan(40);
  expect(day.explainedShare).toBeGreaterThanOrEqual(0.85);

  // A finding about the floor heater, announced once, not on every 5-minute analysis.
  expect(view.findings.some((f: any) => f.loadId === floor.id)).toBe(true);
  const announced = homey.ofTrigger('finding_new').length;
  expect(announced).toBeGreaterThanOrEqual(1);
  expect(announced).toBeLessThanOrEqual(view.findings.length + 3);
}, 180_000);

test('flows: start and stop fire for the right load, and the condition follows the live state', async () => {
  await sim.until(() => !house.isOn('floor', homey.now), 70 * MIN);
  await sim.until(() => house.isOn('floor', homey.now), 70 * MIN);
  await sim.advance(MIN);

  const started = homey.ofTrigger('load_started').filter(t => t.state.loadId === floor.id).pop()!;
  expect(started).toBeDefined();
  expect(Math.abs(started.tokens.power - 1330)).toBeLessThan(60);
  expect(await homey.run.get('load_started')!({ load: { id: floor.id } }, started.state)).toBe(true);
  expect(await homey.run.get('load_started')!({ load: { id: hp.id } }, started.state)).toBe(false);
  expect(await homey.run.get('load_running')!({ load: { id: floor.id } })).toBe(true);

  await sim.until(() => !house.isOn('floor', homey.now), 30 * MIN);
  await sim.advance(MIN);
  const stopped = homey.ofTrigger('load_stopped').filter(t => t.state.loadId === floor.id).pop()!;
  expect(Math.abs(stopped.tokens.minutes - 21)).toBeLessThanOrEqual(1);
  expect(Math.abs(stopped.tokens.kwh - FLOOR_KWH_PER_RUN)).toBeLessThan(0.03);
  expect(await homey.run.get('load_running')!({ load: { id: floor.id } })).toBe(false);
}, 60_000);

test('naming a load and the dashboard widget', async () => {
  await expect(api.setName(ctx({ name: 'x' }))).rejects.toThrow('loadId missing');
  expect(await api.setName(ctx({ loadId: floor.id, name: '  Kitchen floor  ' }))).toEqual({ ok: true });
  expect((await homey.autocomplete.get('load_running')!('kitch', {})) as any[]).toEqual([
    expect.objectContaining({ id: floor.id, name: 'Kitchen floor' }),
  ]);

  await sim.until(() => house.isOn('floor', homey.now), 70 * MIN);
  await sim.advance(MIN);
  const w = await widget.getNow({ homey });
  expect(Math.abs(w.totalW - house.power(homey.now).total)).toBeLessThan(30);
  expect(w.running[0]).toMatchObject({ name: 'Kitchen floor' });
  expect(Math.abs(w.running[0].w - 1330)).toBeLessThan(60);
  expect(Math.abs(w.baseW - 410)).toBeLessThan(40);
  expect(w.today.kWh).toBeGreaterThan(0);
  expect(w.top.title).toEqual(expect.any(String));
  expect(w.currency).toBe('SEK');
}, 60_000);

test('a paired load device follows the runs and meters their energy', async () => {
  await sim.until(() => !house.isOn('floor', homey.now), 30 * MIN);
  floorDevice = await pair(homey, floor.id);
  expect((await homey.driver.onPairListDevices()).some((d: any) => d.data.loadId === floor.id)).toBe(false);
  expect(floorDevice.getCapabilityValue('meter_power')).toBe(0);

  await sim.until(() => house.isOn('floor', homey.now), 70 * MIN);
  await sim.advance(MIN);
  expect(floorDevice.getCapabilityValue('load_running')).toBe(true);
  expect(Math.abs(floorDevice.getCapabilityValue('measure_power') - 1330)).toBeLessThan(60);

  // From here, the meter adds each run that ends: the one running now and five more.
  const from = homey.now;
  const m0 = floorDevice.getCapabilityValue('meter_power');
  await sim.advance(6 * 63 * MIN);
  const runs = house.truth('floor', from - 2 * MIN, homey.now).filter(r => r.end < homey.now).length;
  expect(runs).toBe(6);
  const ratio = (floorDevice.getCapabilityValue('meter_power') - m0) / (runs * FLOOR_KWH_PER_RUN);
  expect(ratio).toBeGreaterThan(0.95);
  expect(ratio).toBeLessThan(1.05);
}, 60_000);

test('switch-off tests: off confirms the floor heater, a wrong guess is rejected', async () => {
  // No length given: the app picks one long enough to decide (3 expected starts, here 4 h).
  const right = await api.startTest(ctx({ loadId: floor.id, label: 'Kitchen floor thermostat' }));
  expect(right.hours).toBe(4);
  // The measured rate: true starts per day less the few missed (see the first test).
  expect(Math.abs((right.rate * 24) / (1440 / 63) - 1)).toBeLessThan(0.06);
  house.load('floor').enabled = false;
  await sim.advance(4 * HOUR + 10 * MIN);
  house.load('floor').enabled = true;

  await expect(api.startTest(ctx({ label: 'x' }))).rejects.toThrow('loadId missing');
  const wrong = await api.startTest(ctx({ loadId: hp.id, label: 'the spa' }));
  expect(wrong.hours).toBe(8);
  await sim.advance(8 * HOUR + 10 * MIN);

  // Verdicts are kept in the settings once a test ends.
  const saved = homey.settings.get('experiments') as any[];
  expect(saved.find(e => e.id === right.id).result.status).toBe('confirmed');
  expect(saved.find(e => e.id === wrong.id).result.status).toBe('rejected');
  const view = await api.getState(ctx());
  expect(view.experiments.map((e: any) => e.status).sort()).toEqual(['confirmed', 'rejected']);
  // The user's name wins over the test's label; the floor is still found after the pause.
  expect(view.loads.find((l: any) => l.id === floor.id)).toMatchObject({ name: 'Kitchen floor', source: 'user' });
}, 120_000);

test('Homey restarts: loads keep their ids, names, history and paired device', async () => {
  // Restart in the middle of a floor run: the run must survive and end as one whole run.
  await sim.until(() => !house.isOn('floor', homey.now), 70 * MIN);
  await sim.until(() => house.isOn('floor', homey.now), 70 * MIN);
  await sim.advance(5 * MIN);
  const before = await api.getState(ctx());
  const runsBefore = before.loads.find((l: any) => l.id === floor.id).count;
  await app.onUninit();
  homey.stopAll();
  expect(fs.existsSync(process.env.POWER_DETECTIVE_STATE!)).toBe(true);
  expect(world.listeners.size).toBe(0);
  await sim.advance(MIN); // Homey is down for a minute; the floor keeps running.
  sim.forgetEmitted();
  app = await boot(homey);
  const stopsBefore = homey.ofTrigger('load_stopped').length;
  await sim.until(() => !house.isOn('floor', homey.now), 30 * MIN);
  await sim.advance(MIN);
  const whole = homey.ofTrigger('load_stopped').slice(stopsBefore).find(t => t.state.loadId === floor.id)!;
  expect(whole.tokens.minutes).toBe(21);
  expect(floorDevice.getCapabilityValue('load_running')).toBe(false);
  await sim.advance(10 * MIN);
  const after = await api.getState(ctx());
  expect(after.loads.find((l: any) => l.id === floor.id)).toMatchObject({ name: 'Kitchen floor' });
  expect(after.loads.find((l: any) => l.id === hp.id)).toMatchObject({ name: 'Värmepump' });
  expect(after.loads.find((l: any) => l.id === floor.id).count).toBeGreaterThanOrEqual(runsBefore);

  const seen = homey.ofTrigger('load_started').length;
  await sim.until(() => !house.isOn('floor', homey.now), 70 * MIN);
  await sim.until(() => house.isOn('floor', homey.now), 70 * MIN);
  await sim.advance(MIN);
  expect(homey.ofTrigger('load_started').slice(seen).some(t => t.state.loadId === floor.id)).toBe(true);
  expect(floorDevice.getCapabilityValue('load_running')).toBe(true);
}, 60_000);

test('after a week: one weekly summary, written without an API key, and still accurate', async () => {
  await sim.until(() => homey.notes.length > 0, 6 * 24 * HOUR);
  expect(homey.notes).toHaveLength(1);
  expect(homey.notes[0]).toMatch(/^Power Detective: Last \d days: \d+ kWh/);
  expect(homey.settings.get('last_summary')).toMatchObject({ source: 'template' });
  await sim.advance(24 * HOUR);
  expect(homey.notes).toHaveLength(1);

  // A week of data, including a 4 h switch-off and a restart: the floor is still found as well.
  const view = await api.getState(ctx());
  const from = homey.now - 3 * 24 * HOUR;
  expect(judge('floor', floor.id, from, homey.now).clean.recall).toBe(1);
  expect(judge('heatpump', hp.id, from, homey.now).clean.recall).toBe(1);
  expect(judge('floor', floor.id, from, homey.now).all.f1).toBeGreaterThanOrEqual(0.95);
  expect(judge('heatpump', hp.id, from, homey.now).all.f1).toBeGreaterThanOrEqual(0.85);
  expect(view.observedHours).toBeGreaterThanOrEqual(7 * 24);
  expect((await api.writeSummary(ctx())).source).toBe('template');
}, 300_000);
