/** Minimal stand-ins for the Homey SDK classes, for running app code in tests. */
export class App {
  homey: any;
  log = (..._args: unknown[]) => undefined;
  error = (..._args: unknown[]) => undefined;
  constructor(homey?: any) {
    this.homey = homey;
  }
}

/** A driver keeps its paired devices; tests add them with `devices.push`. */
export class Driver extends App {
  devices: Device[] = [];
  getDevices(): Device[] {
    return this.devices;
  }
}

/** A device with its data and an in-memory capability store, as Homey keeps them. */
export class Device extends App {
  private caps = new Map<string, unknown>();
  private data: Record<string, unknown>;
  constructor(homey?: any, data?: Record<string, unknown>) {
    super(homey);
    this.data = data ?? {};
  }
  getData(): Record<string, unknown> {
    return this.data;
  }
  getCapabilityValue(cap: string): unknown {
    return this.caps.has(cap) ? this.caps.get(cap) : null;
  }
  async setCapabilityValue(cap: string, value: unknown): Promise<void> {
    this.caps.set(cap, value);
  }
}

export default { App, Driver, Device };
