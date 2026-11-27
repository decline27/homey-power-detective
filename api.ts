/** Endpoints for the settings page. */
interface Ctx {
  homey: { app: any };
  body?: any;
  params?: Record<string, string>;
  query?: Record<string, string>;
}

module.exports = {
  async getState({ homey }: Ctx) {
    return homey.app.view();
  },

  /** What is on now, fitted to the meter (small: for the wall dashboard and the like). */
  async getLive({ homey }: Ctx) {
    return homey.app.live() ?? { rows: null };
  },

  /** GET /runs?since=<ms>: finished runs with their load's name (24 h at most). */
  async getRuns({ homey, query }: Ctx) {
    const since = Number(query && query.since) || Date.now() - 6 * 3_600_000;
    return { at: Date.now(), runs: homey.app.runs(since) };
  },

  async getMeters({ homey }: Ctx) {
    return homey.app.meterOptions();
  },

  async setName({ homey, body }: Ctx) {
    if (!body || typeof body.loadId !== 'string') throw new Error('loadId missing');
    homey.app.setName(body.loadId, String(body.name ?? ''));
    await homey.app.refresh();
    return { ok: true };
  },

  /** { deviceId, steered: true|false }: a device someone else starts and stops (a grid deal). */
  async setSteered({ homey, body }: Ctx) {
    if (!body || typeof body.deviceId !== 'string') throw new Error('deviceId missing');
    return { ok: true, steered: homey.app.setSteered(body.deviceId, body.steered !== false) };
  },

  async startTest({ homey, body }: Ctx) {
    if (!body || typeof body.loadId !== 'string') throw new Error('loadId missing');
    const exp = homey.app.startExperiment(body.loadId, String(body.label ?? ''), Number(body.hours) || undefined);
    await homey.app.refresh();
    return exp;
  },

  async writeSummary({ homey }: Ctx) {
    return homey.app.writeSummary(false);
  },

  /** The state as last saved, to replay the analysis off the Homey (app logs cannot be read). */
  async getSavedState({ homey }: Ctx) {
    return homey.app.savedState();
  },

  /** The days of raw meter values on file (see RawRecorder). */
  async getRawDays({ homey }: Ctx) {
    return homey.app.rawDays();
  },

  /** One day of raw values, gzipped and base64-encoded. */
  async getRawDay({ homey, params }: Ctx) {
    const day = homey.app.rawDay(String(params?.date ?? ''));
    if (!day) throw new Error('No such day');
    return day;
  },
};
