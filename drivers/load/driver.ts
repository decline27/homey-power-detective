import Homey from 'homey';

/** Found loads become devices, so Homey Energy shows them next to the metered ones. */
module.exports = class LoadDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('Load driver ready');
  }

  async onPairListDevices() {
    const app = this.homey.app as { pairableLoads(): Array<{ name: string; data: { id: string; loadId: string } }> };
    const taken = new Set(this.getDevices().map(d => d.getData()?.loadId));
    return app.pairableLoads().filter(d => !taken.has(d.data.loadId));
  }
};
