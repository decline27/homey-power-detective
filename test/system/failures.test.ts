/**
 * System test: what goes wrong in real homes. Each case starts a fresh Homey and house.
 *
 *   Homey API not ready at boot ─> retried every minute
 *   two meters, none chosen     ─> asks; the user's pick in settings connects it
 *   meter without phase data    ─> still finds loads from the total
 *   Pulse goes quiet            ─> no made-up readings; a recovery read; back when it returns
 *   garbage values, bad state   ─> ignored, starts clean
 */
jest.mock('homey-api', () => require('./harness').homeyApiMock);

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FakeHomey, HOUR, MIN, Sim, boot, meterDevice, referenceHouse, standardDevices, world } from './harness';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-failures-'));
const STATE = path.join(tmp, 'state.json');
process.env.POWER_DETECTIVE_STATE = STATE;
const api = require('../../api');

let homey: FakeHomey;
let sim: Sim;
let app: any;
/** Minutes of metered time the app has counted (judge-only look inside). */
const coveredMinutes = () => app.engine.days().reduce((a: number, d: any) => a + d.coveredMs, 0) / MIN;

beforeEach(() => {
  fs.rmSync(STATE, { force: true });
  world.listeners.clear();
  world.apiFailures = 0;
  world.getDeviceCalls = 0;
  standardDevices();
  homey = new FakeHomey();
  sim = new Sim(referenceHouse(), homey);
  jest.spyOn(Date, 'now').mockImplementation(() => homey.now);
});
afterEach(async () => {
  await app?.onUninit();
  app = null;
  jest.restoreAllMocks();
});

test('Homey API not ready at boot: the app says so, retries every minute, then listens', async () => {
  world.apiFailures = 2;
  app = await boot(homey);
  expect(app.widgetState().status).toMatch(/^Cannot reach Homey's devices: Homey API not ready/);
  expect(app.widgetState().totalW).toBeNull();
  await sim.advance(MIN);
  expect(app.widgetState().status).toMatch(/^Cannot reach/);
  await sim.advance(MIN);
  expect(app.widgetState().status).toBe('Listening to Pulse');
  await sim.advance(MIN);
  expect(Math.abs(app.widgetState().totalW - sim.house.power(homey.now).total)).toBeLessThan(30);
});

test('two house meters and no choice: asks, then connects to the one picked in settings', async () => {
  world.devices.p1 = meterDevice('p1', 'P1 reader');
  app = await boot(homey);
  expect(app.widgetState().status).toBe('No house meter found: choose one in the settings');
  const meters = await api.getMeters({ homey });
  expect(meters.chosen).toBeNull();
  expect(meters.candidates.map((c: any) => c.id).sort()).toEqual(['p1', 'pulse']);
  await sim.advance(10 * MIN);
  expect(app.widgetState()).toMatchObject({ totalW: null, running: [], loads: 0 });
  expect((await api.getState({ homey })).loads).toEqual([]);

  homey.settings.set('house_meter_device_id', 'pulse');
  await sim.advance(MIN);
  expect(app.widgetState().status).toBe('Listening to Pulse');
  expect((await api.getMeters({ homey })).chosen).toBe('pulse');
  expect(app.widgetState().totalW).not.toBeNull();
});

test('a meter without phase data: loads are still found from the total', async () => {
  world.devices.pulse = meterDevice('pulse', 'Pulse', { phases: false });
  app = await boot(homey);
  await sim.advance(12 * HOUR);
  const view = await api.getState({ homey });
  const floor = view.loads.find((l: any) => Math.abs(l.medianW - 1330) < 80);
  expect(floor).toMatchObject({ rhythmic: true });
  expect(Math.abs(floor.periodMinutes - 63)).toBeLessThan(3);
});

test('the Pulse goes quiet: no made-up readings, one recovery read, and back when it returns', async () => {
  app = await boot(homey);
  await sim.advance(30 * MIN);
  const before = coveredMinutes();
  sim.pulseOnline = false;
  const reads = world.getDeviceCalls;
  await sim.advance(5 * MIN);
  expect(app.widgetState().totalW).toBeNull();
  // The sampler tried to read the device directly, and did not invent data from stale values.
  expect(world.getDeviceCalls).toBeGreaterThan(reads);
  await sim.advance(10 * MIN);
  const during = coveredMinutes();
  // Covered time stops growing once readings are stale (the total is held 2 min at most).
  expect(during - before).toBeLessThanOrEqual(2.5);

  sim.pulseOnline = true;
  sim.forgetEmitted();
  await sim.advance(2 * MIN);
  expect(Math.abs(app.widgetState().totalW - sim.house.power(homey.now).total)).toBeLessThan(30);
});

test('garbage values are ignored and sampling carries on', async () => {
  app = await boot(homey);
  await sim.advance(5 * MIN);
  world.listeners.get('pulse:measure_power')!(NaN);
  world.listeners.get('pulse:measure_current.L1')!(Number.POSITIVE_INFINITY);
  await sim.advance(10 * 1000);
  sim.forgetEmitted();
  await sim.advance(5 * MIN);
  expect(Math.abs(app.widgetState().totalW - sim.house.power(homey.now).total)).toBeLessThan(30);
});

test('a corrupt saved state: the app starts clean instead of crashing', async () => {
  fs.writeFileSync(STATE, '{"engine": {not json');
  app = await boot(homey);
  expect(app.widgetState().status).toBe('Listening to Pulse');
  expect((await api.getState({ homey })).loads).toEqual([]);
  await sim.advance(10 * MIN);
  await app.onUninit();
  expect(() => JSON.parse(fs.readFileSync(STATE, 'utf8'))).not.toThrow();
  app = null;
});

test('without a paired driver or load devices nothing breaks', async () => {
  app = await boot(homey);
  homey.driver = null;
  await sim.advance(8 * HOUR);
  const view = await api.getState({ homey });
  expect(view.loads.length).toBeGreaterThan(0);
});
