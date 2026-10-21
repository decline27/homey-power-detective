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
  private seed = 7;
  constructor(public loads: SimLoad[]) {}

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
      for (let k = 0; k < 3; k++) w[k] += l.w[k];
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
    { key: 'heatpump', w: [310, 300, 320], schedule: cycle(150, 45, 30), enabled: true },
    { key: 'kettle', w: [0, 2000, 0], schedule: daily([[7, 10, 3], [12, 32, 3], [18, 4, 3]]), enabled: true },
    { key: 'oven', w: [0, 0, 1800], schedule: daily([[17, 15, 40]]), enabled: true },
  ]);
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
    const hp = world.devices.hp;
    if (hp) hp.capabilitiesObj.measure_power.value = this.house.isOn('heatpump', t) ? 930 : 15;
    const home = world.devices.home;
    if (home) {
      const hour = new Date(t + 2 * HOUR).getUTCHours();
      home.capabilitiesObj.measure_price_total.value = hour >= 7 && hour < 9 ? 3.2 : hour >= 17 && hour < 20 ? 3.6 : 1.4;
    }
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
