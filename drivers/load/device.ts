import Homey from 'homey';

/**
 * One found load. Power is the load's step while it runs and 0 otherwise; the meter adds each
 * finished run, so Homey Energy can show the load beside the metered devices.
 */
module.exports = class LoadDevice extends Homey.Device {
  async onInit(): Promise<void> {
    if (this.getCapabilityValue('meter_power') === null) await this.setCapabilityValue('meter_power', 0);
    if (this.getCapabilityValue('measure_power') === null) await this.setCapabilityValue('measure_power', 0);
    if (this.getCapabilityValue('load_running') === null) await this.setCapabilityValue('load_running', false);
  }

  onStart(w: number): void {
    this.setCapabilityValue('measure_power', Math.max(0, w)).catch(e => this.error(e));
    this.setCapabilityValue('load_running', true).catch(e => this.error(e));
  }

  onStop(kWh: number): void {
    const total = (Number(this.getCapabilityValue('meter_power')) || 0) + Math.max(0, kWh);
    this.setCapabilityValue('meter_power', Math.round(total * 1000) / 1000).catch(e => this.error(e));
    this.setCapabilityValue('measure_power', 0).catch(e => this.error(e));
    this.setCapabilityValue('load_running', false).catch(e => this.error(e));
  }
};
