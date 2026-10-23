/**
 * Runs the app's wiring against a fake Homey: the Pulse device sends live values, the sampler
 * turns them into readings, a load is found, flows fire, settings actions work, state is saved.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const listeners = new Map<string, (v: number) => void>();
const pulseDevice = {
  id: 'pulse',
  name: 'Pulse',
  driverId: 'homey:app:com.tibber:pulse',
  capabilities: ['measure_power', 'meter_power.imported', 'measure_current.L1', 'measure_current.L2', 'measure_current.L3'],
  capabilitiesObj: { measure_power: { value: 400, lastUpdated: new Date().toISOString() } } as Record<string, { value: number; lastUpdated: string }>,
  energyObj: { cumulative: true },
  makeCapabilityInstance: (cap: string, fn: (v: number) => void) => {
    listeners.set(cap, fn);
    return { destroy: () => listeners.delete(cap) };
  },
};
const priceDevice = { id: 'home', name: 'Home', capabilities: ['measure_price_total'], capabilitiesObj: { measure_price_total: { value: 2.3 } } };
jest.mock('homey-api', () => ({
  HomeyAPI: {
    createAppAPI: async () => ({
      devices: {
        getDevices: async () => ({ pulse: pulseDevice, home: priceDevice }),
        getDevice: async () => pulseDevice,
      },
    }),
  },
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
process.env.POWER_DETECTIVE_STATE = path.join(tmp, 'state.json');

function fakeHomey() {
  const settings = new Map<string, unknown>();
  const triggered: Array<{ id: string; tokens: unknown }> = [];
  const run = new Map<string, (args: any, state?: any) => Promise<unknown>>();
  const autocomplete = new Map<string, (q: string, args: any) => Promise<unknown>>();
  const card = (id: string) => ({
    trigger: async (tokens: unknown) => void triggered.push({ id, tokens }),
    registerRunListener(fn: any) { run.set(id, fn); return this; },
    registerArgumentAutocompleteListener(_name: string, fn: any) { autocomplete.set(id, fn); return this; },
  });
  return {
    triggered,
    run,
    autocomplete,
    settings: {
      get: (k: string) => settings.get(k),
      set: (k: string, v: unknown) => void settings.set(k, v),
      unset: (k: string) => void settings.delete(k),
      on: () => undefined,
    },
    clock: { getTimezone: () => 'Europe/Stockholm' },
    flow: { getTriggerCard: card, getConditionCard: card, getActionCard: card },
    notifications: { createNotification: async () => undefined },
    drivers: { getDriver: () => ({ getDevices: () => [] }) },
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    on: () => undefined,
  };
}

test('live values become readings; loads, flows, actions and saved state work end to end', async () => {
  const AppClass = require('../../app');
  const homey = fakeHomey();
  const app = new AppClass(homey);
  await app.onInit();
  expect([...listeners.keys()]).toContain('measure_current.L1');

  // Feed 12 hours: a 1330 W L1 heater, 21 min every 63 min, sampled every 10 s.
  const start = Date.now();
  const spy = jest.spyOn(Date, 'now');
  for (let i = 0; i < 12 * 360; i++) {
    const t = start + i * 10_000;
    spy.mockReturnValue(t);
    const on = ((t - start) / 60_000) % 63 < 21;
    listeners.get('measure_power')!(400 + (on ? 1330 : 0));
    listeners.get('measure_current.L1')!((150 + (on ? 1330 : 0)) / 230);
    listeners.get('measure_current.L2')!(1);
    listeners.get('measure_current.L3')!(0.5);
    (app as any).sample();
    if (i % 6 === 0) await (app as any).trackDevices();
  }
  await app.refresh();
  const view = await app.view();
  expect(view.status).toBe('Listening to Pulse');
  const heater = view.loads.find((l: any) => l.phases === 'L1');
  expect(heater).toBeDefined();
  expect(heater).toMatchObject({ rhythmic: true });
  expect(view.avgPrice).toBeCloseTo(2.3);
  expect(homey.triggered.map(t => t.id)).toContain('finding_new');

  // Once loads are known, a new start fires the flow with the load.
  for (let i = 0; i < 400; i++) {
    const t = start + (12 * 360 + i) * 10_000;
    spy.mockReturnValue(t);
    const on = ((t - start) / 60_000) % 63 < 21;
    listeners.get('measure_power')!(400 + (on ? 1330 : 0));
    listeners.get('measure_current.L1')!((150 + (on ? 1330 : 0)) / 230);
    listeners.get('measure_current.L2')!(1 + (i % 2) * 0.1);
    listeners.get('measure_current.L3')!(0.5 + (i % 2) * 0.1);
    (app as any).sample();
  }
  expect(homey.triggered.map(t => t.id)).toContain('load_started');
  expect(homey.triggered.map(t => t.id)).toContain('load_stopped');

  app.setName(heater.id, 'Kitchen floor');
  await app.refresh();
  expect(app.loadsForAutocomplete('kitch')).toEqual([expect.objectContaining({ id: heater.id, name: 'Kitchen floor' })]);
  // The widget: live total, what is running by name, today and the top finding.
  const w = app.widgetState();
  expect(w.totalW).toBeGreaterThan(0);
  expect(w.loads).toBe(view.loads.length);
  expect(w.today).not.toBeNull();
  expect(w.top).not.toBeNull();
  for (const r of w.running) expect(r.w).toBeGreaterThan(0);
  expect(w.running.filter((r: any) => r.name).every((r: any) => r.name === 'Kitchen floor')).toBe(true);
  const widgetApi = require('../../widgets/now/api.js');
  expect(await widgetApi.getNow({ homey: { app } })).toMatchObject({ loads: w.loads });
  // Flow cards: trigger filters, the running condition, autocomplete and the test action.
  expect(await homey.run.get('load_started')!({ load: { id: heater.id } }, { loadId: heater.id })).toBe(true);
  expect(await homey.run.get('load_started')!({ load: { id: 'other' } }, { loadId: heater.id })).toBe(false);
  expect(await homey.run.get('load_stopped')!({}, { loadId: heater.id })).toBe(true);
  expect(typeof (await homey.run.get('load_running')!({ load: { id: heater.id } }))).toBe('boolean');
  expect(app.isRunning('nope')).toBe(false);
  expect(await homey.autocomplete.get('load_running')!('', {})).toHaveLength(view.loads.length);
  expect(await homey.run.get('start_test')!({ load: { id: heater.id }, label: 'thermostat', hours: 3 })).toBe(true);
  // A second press while that test runs is the same test, not another one.
  const exp = app.startExperiment(heater.id, 'kitchen thermostat');
  expect(exp.label).toBe('thermostat');
  expect(exp.hours).toBe(3);
  expect(app.startExperiment(heater.id, '').id).toBe(exp.id);
  expect(app.pairableLoads().length).toBeGreaterThan(0);
  app.setName(heater.id, '');
  const summary = await app.writeSummary(true);
  expect(summary.source).toBe('template');
  expect((await app.meterOptions()).chosen).toBe('pulse');

  await app.onUninit();
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8'));
  expect(saved.engine.activations.length).toBeGreaterThan(5);
  spy.mockRestore();
});
