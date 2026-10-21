/** The parts of the Homey Apps SDK v3 this app uses. */
declare module 'homey' {
  interface FlowCardTrigger {
    trigger(tokens?: Record<string, unknown>, state?: Record<string, unknown>): Promise<void>;
    registerRunListener(fn: (args: any, state: any) => Promise<boolean> | boolean): this;
  }
  interface FlowCardWithArgs {
    registerRunListener(fn: (args: any, state?: any) => Promise<any> | any): this;
    registerArgumentAutocompleteListener(
      name: string,
      fn: (query: string, args: any) => Promise<Array<{ name: string; description?: string; id: string }>>
    ): this;
  }
  interface HomeyInstance {
    settings: {
      get(key: string): any;
      set(key: string, value: any): void;
      unset(key: string): void;
      on(event: 'set' | 'unset', fn: (key: string) => void): void;
    };
    clock: { getTimezone(): string };
    flow: {
      getTriggerCard(id: string): FlowCardTrigger;
      getConditionCard(id: string): FlowCardWithArgs;
      getActionCard(id: string): FlowCardWithArgs;
    };
    notifications: { createNotification(n: { excerpt: string }): Promise<void> };
    drivers: { getDriver(id: string): Driver };
    app: any;
    setInterval(fn: () => void, ms: number): any;
    clearInterval(handle: any): void;
    setTimeout(fn: () => void, ms: number): any;
    clearTimeout(handle: any): void;
    on(event: string, fn: (...args: any[]) => void): void;
  }

  export class App {
    homey: HomeyInstance;
    manifest: any;
    id: string;
    log(...args: any[]): void;
    error(...args: any[]): void;
    onInit(): Promise<void>;
    onUninit(): Promise<void>;
  }

  export class Driver {
    homey: HomeyInstance;
    log(...args: any[]): void;
    error(...args: any[]): void;
    getDevices(): Device[];
    onInit(): Promise<void>;
    onPairListDevices(): Promise<Array<{ name: string; data: Record<string, unknown>; store?: Record<string, unknown> }>>;
  }

  export class Device {
    homey: HomeyInstance;
    driver: Driver;
    log(...args: any[]): void;
    error(...args: any[]): void;
    getData(): any;
    getName(): string;
    getStoreValue(key: string): any;
    setStoreValue(key: string, value: any): Promise<void>;
    hasCapability(id: string): boolean;
    getCapabilityValue(id: string): any;
    setCapabilityValue(id: string, value: any): Promise<void>;
    setUnavailable(message?: string): Promise<void>;
    setAvailable(): Promise<void>;
    onInit(): Promise<void>;
    onDeleted(): Promise<void>;
  }
}
