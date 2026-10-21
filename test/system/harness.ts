/**
 * The whole app under test, from the outside.
 *
 *   SimHouse ──5 s──> Pulse device (listeners, change-only like Homey) ─┐
 *            ──────> metered heat pump, price, solar devices ───────────┤  fake homey-api
 *                                                                       ▼
 *   FakeHomey (virtual clock) runs the app's own timers ──> app.ts ──> flows, settings,
 *                                                            │          notifications,
 *                                                            └────────> load devices (driver)
 *
 * The app's timers do the work (sample 10 s, devices 1 min, analysis 5 min, save 5 min); tests
 * only advance the clock and use the public surfaces: api.ts, the widget api, flow cards, the
 * driver and its devices. The house keeps the ground truth, so the tests judge what was found.
 */
import type { Vec3 } from '../../src/engine/types';
import type { Interval } from '../../src/engine/score';
import { localDate } from '../../src/engine/day-meter';

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
/** Monday 5 October 2026, 00:00 in Stockholm (UTC+2). */
export const START = Date.UTC(2026, 9, 4, 22, 0, 0);
export const TICK = 5 * SEC;

// ---- the house -----------------------------------------------------------------------------

export interface SimLoad {
  key: string;
  w: Vec3;
  /** Whether the load's own schedule has it on at t. */
  schedule(t: number): boolean;
  /** False while the user has it switched off (a switch-off test). */
  enabled: boolean;
  /** Scales `w` over time (a modulating heat pump, radiators following the weather). */
  profile?: (t: number) => number;
  /** A Homey device that meters this load, reporting `lagMs` late (MELCloud: minutes). */
  meter?: { deviceId: string; lagMs: number; standbyW?: number };
}

/** On for `onMin` at the start of every `periodMin`, from `offsetMin` after START. */
export const cycle = (periodMin: number, onMin: number, offsetMin = 0) => (t: number) => {
  const m = (t - START) / MIN - offsetMin;
  return m >= 0 && m % periodMin < onMin;
};

/** On at fixed local times each day: [hour, minute, minutes on]. */
export const daily = (runs: Array<[number, number, number]>) => (t: number) => {
  const m = (((t - START) / MIN) % 1440 + 1440) % 1440;
  return runs.some(([h, mm, d]) => m >= h * 60 + mm && m < h * 60 + mm + d);
};

export class SimHouse {
  base: Vec3 = [180, 140, 90];
  /** Outdoor temperature (°C), reported by the heat pump when set. */
  outdoor: ((t: number) => number) | null = null;
  private seed = 7;
  constructor(public loads: SimLoad[]) {}

  /** A load's power at t (W). */
  loadW(key: string, t: number): number {
    const l = this.load(key);
    if (!l.enabled || !l.schedule(t)) return 0;
    return (l.w[0] + l.w[1] + l.w[2]) * (l.profile ? l.profile(t) : 1);
  }

  load(key: string): SimLoad {
    const l = this.loads.find(x => x.key === key);
    if (!l) throw new Error(`no load ${key}`);
    return l;
  }

  isOn(key: string, t: number): boolean {
    const l = this.load(key);
    return l.enabled && l.schedule(t);
  }

  /** Small deterministic noise, well inside the detector's tolerance. */
  private noise(): number {
    this.seed = (this.seed * 1103515245 + 12345) % 2147483648;
    return (this.seed / 2147483648 - 0.5) * 16;
  }

  power(t: number): { w: Vec3; total: number } {
    const w: Vec3 = [this.base[0] + this.noise(), this.base[1] + this.noise(), this.base[2] + this.noise()];
    for (const l of this.loads) {
      if (!l.enabled || !l.schedule(t)) continue;
      const f = l.profile ? l.profile(t) : 1;
      for (let k = 0; k < 3; k++) w[k] += l.w[k] * f;
    }
    return { w, total: w[0] + w[1] + w[2] };
  }

  /** Ground truth: the runs of a load between two times (scanned on the 5 s grid). */
  truth(key: string, from: number, to: number): Interval[] {
    const out: Interval[] = [];
    let open: number | null = null;
    for (let t = from; t <= to; t += TICK) {
      const on = this.isOn(key, t);
      if (on && open === null) open = t;
      if (!on && open !== null) {
        out.push({ start: open, end: t });
        open = null;
      }
    }
    return out;
  }
}

/**
 * The reference house: a kitchen floor heater on L1 cycling every 63 min (the load Kjetil found),
 * a 3-phase heat pump metered by its own Homey device, a kettle and an oven on fixed times.
 */
export function referenceHouse(): SimHouse {
  return new SimHouse([
    { key: 'floor', w: [1330, 0, 0], schedule: cycle(63, 21), enabled: true },
    { key: 'heatpump', w: [310, 300, 320], schedule: cycle(150, 45, 30), enabled: true, meter: { deviceId: 'hp', lagMs: 3 * MIN, standbyW: 15 } },
    { key: 'kettle', w: [0, 2000, 0], schedule: daily([[7, 10, 3], [12, 32, 3], [18, 4, 3]]), enabled: true },
    { key: 'oven', w: [0, 0, 1800], schedule: daily([[17, 15, 40]]), enabled: true },
  ]);
}

/** Mean outdoor temperature per day (°C), for ten days, with a daily swing of ±3 °C. */
export const DAY_TEMPS = [8, 2, 12, 5, -2, 10, 4, 0, 7, 3];
export const outdoorAt = (t: number) => {
  const day = Math.floor((t - START) / (24 * HOUR));
  const hour = ((t - START) / HOUR) % 24;
  return DAY_TEMPS[Math.min(DAY_TEMPS.length - 1, Math.max(0, day))] + 3 * Math.sin((2 * Math.PI * (hour - 9)) / 24);
};

/**
 * A house where much is metered already, as in Kjetil's: an Easee charger (reports at once) and
 * a spa (10 s late) to subtract live; the heat pump modulating and reported by MELCloud 3 min
 * late (energy only); and, unmetered, the floor heater, kettle, oven, and radiators that follow
 * the outdoor temperature smoothly (no steps to detect: heating the account must estimate).
 */
export function meteredHouse(): SimHouse {
  const h = new SimHouse([
    { key: 'floor', w: [1330, 0, 0], schedule: cycle(63, 21), enabled: true },
    { key: 'kettle', w: [0, 2000, 0], schedule: daily([[7, 10, 3], [12, 32, 3], [18, 4, 3]]), enabled: true },
    { key: 'oven', w: [0, 0, 1800], schedule: daily([[17, 15, 40]]), enabled: true },
    { key: 'ev', w: [3680, 3680, 3680], schedule: daily([[1, 40, 150], [18, 20, 100]]), enabled: true, meter: { deviceId: 'easee', lagMs: 0 } },
    { key: 'spa', w: [0, 3000, 0], schedule: cycle(45, 15, 10), enabled: true, meter: { deviceId: 'spa', lagMs: 10 * SEC, standbyW: 15 } },
    {
      key: 'heatpump',
      w: [500, 500, 500],
      schedule: cycle(150, 60, 30),
      enabled: true,
      // Modulates between 40 % and 120 % in 5-minute steps, as an inverter compressor does.
      profile: t => 0.4 + 0.8 * ((Math.floor((t - START) / (5 * MIN)) * 37) % 11) / 10,
      meter: { deviceId: 'hp', lagMs: 3 * MIN, standbyW: 15 },
    },
    { key: 'radiators', w: [0, 0, 1], schedule: () => true, enabled: true, profile: t => 60 * Math.max(0, 17 - outdoorAt(t)) },
  ]);
  h.outdoor = outdoorAt;
  return h;
}

// ---- Homey's devices, as homey-api returns them ------------------------------------------------

type Listener = (v: number) => void;

export const world = {
  devices: {} as Record<string, any>,
  /** createAppAPI fails this many more times (Homey still starting). */
  apiFailures: 0,
  getDeviceCalls: 0,
  listeners: new Map<string, Listener>(),
};

/** jest.mock('homey-api', () => require('../system/harness').homeyApiMock) */
export const homeyApiMock = {
  HomeyAPI: {
    createAppAPI: async () => {
      if (world.apiFailures > 0) {
        world.apiFailures--;
        throw new Error('Homey API not ready');
      }
      return {
        devices: {
          getDevices: async () => ({ ...world.devices }),
          getDevice: async ({ id }: { id: string }) => {
            world.getDeviceCalls++;
            const d = world.devices[id];
            if (!d) throw new Error(`No device ${id}`);
            return d;
          },
        },
      };
    },
  },
};

export function meterDevice(id: string, name: string, opts: { cumulative?: boolean; phases?: boolean } = {}) {
  const phases = opts.phases ?? true;
  return {
    id,
    name,
    driverId: 'homey:app:com.tibber:pulse',
    capabilities: ['measure_power', 'meter_power.imported', ...(phases ? ['measure_current.L1', 'measure_current.L2', 'measure_current.L3'] : [])],
    capabilitiesObj: {} as Record<string, { value: number; lastUpdated: string }>,
    energyObj: { cumulative: opts.cumulative ?? true },
    makeCapabilityInstance: (cap: string, fn: Listener) => {
      world.listeners.set(`${id}:${cap}`, fn);
      return { destroy: () => world.listeners.delete(`${id}:${cap}`) };
    },
  };
}

export function plainDevice(id: string, name: string, cls: string, caps: Record<string, number>) {
  return {
    id,
    name,
    class: cls,
    driverId: `homey:app:other:${cls}`,
    capabilities: Object.keys(caps),
    capabilitiesObj: Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, { value: v }])) as Record<string, { value: number }>,
    makeCapabilityInstance: (cap: string, fn: Listener) => {
      world.listeners.set(`${id}:${cap}`, fn);
      return { destroy: () => world.listeners.delete(`${id}:${cap}`) };
    },
  };
}

/** The usual setup: Pulse, the heat pump through MELCloud, the Tibber home (price), a solar inverter. */
export function standardDevices(): void {
  world.devices = {
    pulse: meterDevice('pulse', 'Pulse'),
    hp: plainDevice('hp', 'Värmepump', 'heatpump', { measure_power: 15 }),
    home: plainDevice('home', 'Hemma', 'other', { measure_price_total: 1.8 }),
    inverter: plainDevice('inverter', 'Solceller', 'solarpanel', { measure_power: 900 }),
  };
}

/** Kjetil-like: also an Easee charger and a spa with their own meters, the heat pump with an energy counter and outdoor temperature. */
export function meteredDevices(): void {
  world.devices = {
    pulse: meterDevice('pulse', 'Pulse'),
    hp: plainDevice('hp', 'Värmepump', 'heatpump', { measure_power: 15, meter_power: 40, 'measure_temperature.outdoor': 8 }),
    easee: plainDevice('easee', 'Easee ladder', 'evcharger', { measure_power: 0, meter_power: 12000 }),
    spa: plainDevice('spa', 'BWA Spa', 'thermostat', { measure_power: 15, meter_power: 28 }),
    home: plainDevice('home', 'Hemma', 'other', { measure_price_total: 1.8 }),
    inverter: plainDevice('inverter', 'Solceller', 'solarpanel', { measure_power: 900 }),
  };
}

// ---- Homey itself -----------------------------------------------------------------------------

interface Timer {
  id: number;
  due: number;
  every: number | null;
  fn: () => unknown;
}

export class FakeHomey {
  now = START;
  app: any = null;
  driver: any = null;
  triggered: Array<{ id: string; tokens: any; state: any }> = [];
  run = new Map<string, (args: any, state?: any) => Promise<unknown>>();
  autocomplete = new Map<string, (q: string, args: any) => Promise<unknown>>();
  notes: string[] = [];
  store = new Map<string, unknown>();
  private handlers: Array<(k: string) => void> = [];
  private timers: Timer[] = [];
  private nextId = 1;

  settings = {
    get: (k: string) => (this.store.has(k) ? this.store.get(k) : null),
    set: (k: string, v: unknown) => {
      this.store.set(k, v);
      this.handlers.forEach(h => h(k));
    },
    unset: (k: string) => void this.store.delete(k),
    on: (ev: string, h: (k: string) => void) => {
      if (ev === 'set') this.handlers.push(h);
    },
  };
  clock = { getTimezone: () => 'Europe/Stockholm' };
  flow = {
    getTriggerCard: (id: string) => this.card(id),
    getConditionCard: (id: string) => this.card(id),
    getActionCard: (id: string) => this.card(id),
  };
  notifications = { createNotification: async ({ excerpt }: { excerpt: string }) => void this.notes.push(excerpt) };
  drivers = {
    getDriver: (id: string) => {
      if (id !== 'load' || !this.driver) throw new Error(`No driver ${id}`);
      return this.driver;
    },
  };

  private card(id: string) {
    const self = this;
    return {
      trigger: async (tokens: any, state?: any) => void self.triggered.push({ id, tokens, state }),
      registerRunListener(fn: any) {
        self.run.set(id, fn);
        return this;
      },
      registerArgumentAutocompleteListener(_arg: string, fn: any) {
        self.autocomplete.set(id, fn);
        return this;
      },
    };
  }

  setInterval(fn: () => unknown, ms: number) {
    const id = this.nextId++;
    this.timers.push({ id, due: this.now + ms, every: ms, fn });
    return id;
  }
  setTimeout(fn: () => unknown, ms: number) {
    const id = this.nextId++;
    this.timers.push({ id, due: this.now + ms, every: null, fn });
    return id;
  }
  clearInterval(id: number) {
    this.timers = this.timers.filter(t => t.id !== id);
  }
  clearTimeout(id: number) {
    this.clearInterval(id);
  }
  /** Removes every timer (an app that is unloaded stops all of them). */
  stopAll() {
    this.timers = [];
  }

  /** Runs every timer that is due, in order, waiting for async ones. */
  async runDue(): Promise<void> {
    for (;;) {
      const t = this.timers.filter(x => x.due <= this.now).sort((a, b) => a.due - b.due)[0];
      if (!t) return;
      if (t.every) t.due += t.every;
      else this.timers = this.timers.filter(x => x !== t);
      await t.fn();
    }
  }

  ofTrigger(id: string) {
    return this.triggered.filter(t => t.id === id);
  }
}

// ---- the simulation -------------------------------------------------------------------------

export class Sim {
  /** False while the Pulse sends nothing (lost Wi-Fi). */
  pulseOnline = true;
  meterId = 'pulse';
  private last = new Map<string, number>();
  /** Ground truth energy (kWh) by local date: 'house', each load key, and 'device:<id>' as reported. */
  truth = new Map<string, Map<string, number>>();

  constructor(public house: SimHouse, public homey: FakeHomey) {}

  get now(): number {
    return this.homey.now;
  }

  /** What the devices report at t; listeners fire only on change, as Homey's do. */
  private emit(t: number): void {
    const { w, total } = this.house.power(t);
    const iso = new Date(t).toISOString();
    const meter = world.devices[this.meterId];
    if (meter && this.pulseOnline) {
      const values: Record<string, number> = { measure_power: Math.round(total) };
      if (meter.capabilities.includes('measure_current.L1')) {
        values['measure_current.L1'] = Math.round((w[0] / 230) * 100) / 100;
        values['measure_current.L2'] = Math.round((w[1] / 230) * 100) / 100;
        values['measure_current.L3'] = Math.round((w[2] / 230) * 100) / 100;
      }
      for (const [cap, v] of Object.entries(values)) {
        meter.capabilitiesObj[cap] = { value: v, lastUpdated: iso };
        const key = `${this.meterId}:${cap}`;
        if (this.last.get(key) === v) continue;
        this.last.set(key, v);
        world.listeners.get(key)?.(v);
      }
    }
    const date = localDate(t, 'Europe/Stockholm');
    const add = (key: string, w: number) => {
      const day = this.truth.get(date) ?? new Map<string, number>();
      this.truth.set(date, day);
      day.set(key, (day.get(key) ?? 0) + (w * TICK) / 3.6e9);
    };
    add('house', total);
    for (const l of this.house.loads) {
      add(l.key, this.house.loadW(l.key, t));
      const m = l.meter;
      const dev = m && world.devices[m.deviceId];
      if (!m || !dev) continue;
      // The device's own view, `lagMs` late; its counter integrates what it reports.
      const v = Math.round(this.house.loadW(l.key, t - m.lagMs) || (m.standbyW ?? 0));
      dev.capabilitiesObj.measure_power = { value: v, lastUpdated: iso };
      if (dev.capabilitiesObj.meter_power) dev.capabilitiesObj.meter_power.value += (v * TICK) / 3.6e9;
      add(`device:${m.deviceId}`, v);
      const key = `${m.deviceId}:measure_power`;
      if (this.last.get(key) !== v) {
        this.last.set(key, v);
        world.listeners.get(key)?.(v);
      }
    }
    const hp = world.devices.hp;
    if (hp && this.house.outdoor && hp.capabilitiesObj['measure_temperature.outdoor']) {
      hp.capabilitiesObj['measure_temperature.outdoor'].value = Math.round(this.house.outdoor(t) * 10) / 10;
    }
    const home = world.devices.home;
    if (home) {
      const hour = new Date(t + 2 * HOUR).getUTCHours();
      home.capabilitiesObj.measure_price_total.value = hour >= 7 && hour < 9 ? 3.2 : hour >= 17 && hour < 20 ? 3.6 : 1.4;
    }
  }

  /** Ground-truth kWh of a key ('house', a load key, 'device:<id>') on a local date. */
  truthKWh(date: string, key: string): number {
    return this.truth.get(date)?.get(key) ?? 0;
  }

  /** Lets a listener re-fire the same value after a reconnect (a new capability instance). */
  forgetEmitted(): void {
    this.last.clear();
  }

  async advance(ms: number): Promise<void> {
    const end = this.homey.now + ms;
    while (this.homey.now < end) {
      this.homey.now += TICK;
      this.emit(this.homey.now);
      await this.homey.runDue();
    }
  }

  /** Advances until `pred` holds, up to `maxMs`. */
  async until(pred: () => boolean, maxMs: number): Promise<void> {
    const end = this.homey.now + maxMs;
    while (!pred()) {
      if (this.homey.now >= end) throw new Error(`Condition not met within ${maxMs / MIN} min`);
      await this.advance(TICK);
    }
  }
}

/** Starts the app and its load driver the way Homey does. */
export async function boot(homey: FakeHomey): Promise<any> {
  const AppClass = require('../../app');
  const DriverClass = require('../../drivers/load/driver');
  const app = new AppClass(homey);
  homey.app = app;
  homey.driver = homey.driver ?? new DriverClass(homey);
  await homey.driver.onInit();
  await app.onInit();
  return app;
}

/** Pairs a load as a device, as the user does in "Add device". */
export async function pair(homey: FakeHomey, loadId: string): Promise<any> {
  const list = await homey.driver.onPairListDevices();
  const item = list.find((d: any) => d.data.loadId === loadId);
  if (!item) throw new Error(`Load ${loadId} is not offered for pairing`);
  const DeviceClass = require('../../drivers/load/device');
  const dev = new DeviceClass(homey, item.data);
  await dev.onInit();
  homey.driver.devices.push(dev);
  return dev;
}
