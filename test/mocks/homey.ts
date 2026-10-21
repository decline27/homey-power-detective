/** Minimal stand-ins for the Homey SDK classes, for running app code in tests. */
export class App {
  homey: any;
  log = (..._args: unknown[]) => undefined;
  error = (..._args: unknown[]) => undefined;
  constructor(homey?: any) {
    this.homey = homey;
  }
}
export class Driver extends App {}
export class Device extends App {}
export default { App, Driver, Device };
