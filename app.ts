/**
 * Power Detective: finds which loads use power in the house from the house meter alone.
 *
 *   house meter (live)  --10 s-->  PowerEngine  --steps/activations-->  flows, load devices
 *   metered devices     --1 min->  ReferenceTracker  (names loads, judges the engine)
 *   price device        --1 h--->  PriceBook
 *   every 5 min: analyse() -> settings page, findings, test results; state saved to /userdata
 */
import Homey from 'homey';
import * as fs from 'fs';
import { classify } from './src/engine/clustering';
import { PowerEngine } from './src/engine/engine';
import { Activation, StepEvent, activationKWh, activationW } from './src/engine/types';
import { Analysis, UserSettings, analyse, displayName } from './src/homey/analysis';
import { DeviceLike, Latest, METER_SETTING, PHASE_CURRENT, PHASE_VOLTAGE, latestFromDevice, meterCandidates, pickMeter, readingFrom } from './src/homey/meter';
import { PRICE_CAPABILITIES, PriceBook } from './src/homey/prices';
import { ReferenceTracker } from './src/homey/references';
import { Experiment, hoursNeeded } from './src/insight/experiments';
import { SummaryInput, summarize } from './src/insight/summary';

/** Homey keeps /userdata across restarts and updates. */
const STATE_FILE = process.env.POWER_DETECTIVE_STATE ?? '/userdata/state.json';
const SAMPLE_MS = 10_000;
const REFERENCE_MS = 60_000;
const ANALYSE_MS = 5 * 60_000;
const SAVE_MS = 5 * 60_000;
const SUMMARY_EVERY_MS = 7 * 86_400_000;

export const SETTINGS = {
  names: 'load_names',
  experiments: 'experiments',
  currency: 'currency',
  flatPrice: 'flat_price',
  cop: 'heat_pump_cop',
  apiKey: 'anthropic_api_key',
  model: 'ai_model',
  language: 'language',
  summary: 'last_summary',
};

interface SavedState {
  engine: unknown;
  refs: unknown;
  prices: unknown;
  findingsSeen: string[];
  summaryAt: number;
}

module.exports = class PowerDetectiveApp extends Homey.App {
  private api: any = null;
  private engine!: PowerEngine;
  private refs = new ReferenceTracker();
  private prices = new PriceBook();
  private latest = new Map<string, Latest>();
  private meterId: string | null = null;
  private meterName: string | null = null;
  private instances: any[] = [];
  private timers: any[] = [];
  private analysis: Analysis | null = null;
  private findingsSeen = new Set<string>();
  private summaryAt = 0;
  private status = 'Starting';
  private timeZone = 'Europe/Stockholm';
  /** Which load each running start was, so its stop goes to the same load (by start time). */
  private startedAs = new Map<number, string>();

  async onInit(): Promise<void> {
    this.timeZone = this.homey.clock.getTimezone() || this.timeZone;
    const saved = this.load();
    this.engine = PowerEngine.restore(saved?.engine, this.timeZone);
    this.refs = ReferenceTracker.restore(saved?.refs);
    this.prices = PriceBook.restore(saved?.prices);
    this.findingsSeen = new Set(Array.isArray(saved?.findingsSeen) ? saved!.findingsSeen : []);
    this.summaryAt = Number(saved?.summaryAt) || 0;

    this.registerFlows();
    this.homey.settings.on('set', key => {
      if (key === METER_SETTING) this.connectMeter().catch(e => this.error('Meter', e));
    });

    await this.connect();

    this.timers.push(this.homey.setInterval(() => this.sample(), SAMPLE_MS));
    this.timers.push(this.homey.setInterval(() => this.trackDevices().catch(e => this.error('Devices', e)), REFERENCE_MS));
    this.timers.push(this.homey.setInterval(() => this.refresh().catch(e => this.error('Analysis', e)), ANALYSE_MS));
    this.timers.push(this.homey.setInterval(() => this.save(), SAVE_MS));
    this.homey.setTimeout(() => this.refresh().catch(e => this.error('Analysis', e)), 30_000);
  }

  async onUninit(): Promise<void> {
    this.timers.forEach(t => this.homey.clearInterval(t));
    this.instances.forEach(i => i?.destroy?.());
    this.save();
  }

  // ---- house meter -------------------------------------------------------------------------

  /** Connects to Homey's devices; retried every minute until it works. */
  private async connect(): Promise<void> {
    try {
      if (!this.api) {
        const { HomeyAPI } = require('homey-api');
        this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
      }
      await this.connectMeter();
    } catch (e) {
      this.status = `Cannot reach Homey's devices: ${(e as Error).message}`;
      this.error('Homey API', e);
    }
  }

  private async devices(): Promise<DeviceLike[]> {
    if (!this.api) return [];
    return Object.values(await this.api.devices.getDevices()) as DeviceLike[];
  }

  async meterOptions(): Promise<{ candidates: Array<{ id: string; name: string; phases: boolean }>; chosen: string | null }> {
    const devices = await this.devices();
    return { candidates: meterCandidates(devices), chosen: pickMeter(devices, this.homey.settings.get(METER_SETTING))?.id ?? null };
  }

  private async connectMeter(): Promise<void> {
    this.instances.forEach(i => i?.destroy?.());
    this.instances = [];
    this.latest.clear();
    const meter = pickMeter(await this.devices(), this.homey.settings.get(METER_SETTING));
    this.meterId = meter?.id ?? null;
    this.meterName = meter?.name ?? null;
    if (!meter) {
      this.status = 'No house meter found: choose one in the settings';
      return;
    }
    const device = await this.api.devices.getDevice({ id: meter.id });
    for (const cap of ['measure_power', ...PHASE_CURRENT, ...PHASE_VOLTAGE]) {
      if (!device.capabilities?.includes(cap)) continue;
      this.instances.push(
        device.makeCapabilityInstance(cap, (value: number) => this.latest.set(cap, { value, at: Date.now() }))
      );
    }
    latestFromDevice(device, Date.now()).forEach((v, k) => this.latest.set(k, v));
    this.status = `Listening to ${meter.name}`;
    this.log(this.status, device.capabilities?.includes('measure_current.L1') ? '(per phase)' : '(total only)');
  }

  private sample(): void {
    try {
      this.sampleOnce();
    } catch (e) {
      // One bad reading must not stop the sampling.
      this.error('Sample', e);
    }
  }

  private sampleOnce(): void {
    const now = Date.now();
    const reading = readingFrom(this.latest, now);
    if (!reading) {
      // Live updates stalled: read the device once (a cheap call) to recover.
      if (this.meterId && this.api) {
        this.api.devices
          .getDevice({ id: this.meterId })
          .then((d: DeviceLike) => latestFromDevice(d, now).forEach((v, k) => this.latest.set(k, v)))
          .catch(() => undefined);
      }
      return;
    }
    const { steps, activations } = this.engine.push(reading);
    steps.filter(s => s.delta[0] + s.delta[1] + s.delta[2] > 0).forEach(s => this.onStart(s));
    activations.forEach(a => this.onStop(a));
  }

  // ---- live events -------------------------------------------------------------------------

  private loadFor(a: Activation) {
    if (!this.analysis) return null;
    const c = classify(a, this.analysis.clusters);
    return c ? this.analysis.loads.find(l => l.id === c.id) ?? null : null;
  }

  private onStart(s: StepEvent): void {
    const load = this.loadFor({ start: s.t, end: s.t, delta: s.delta });
    if (!load) return;
    this.startedAs.set(s.t, load.id);
    if (this.startedAs.size > 200) this.startedAs.delete(this.startedAs.keys().next().value as number);
    const w = Math.round(s.delta[0] + s.delta[1] + s.delta[2]);
    this.homey.flow.getTriggerCard('load_started').trigger({ load: displayName(load), power: w }, { loadId: load.id }).catch(e => this.error(e));
    this.loadDevice(load.id)?.onStart(w);
  }

  private onStop(a: Activation): void {
    // The stop belongs to the load its start was (a long run can fail the stop-time checks).
    const id = this.startedAs.get(a.start);
    this.startedAs.delete(a.start);
    const load = (id && this.analysis?.loads.find(l => l.id === id)) || this.loadFor(a);
    if (!load) return;
    const kWh = activationKWh(a);
    this.homey.flow
      .getTriggerCard('load_stopped')
      .trigger({ load: displayName(load), minutes: Math.round((a.end - a.start) / 60_000), kwh: Math.round(kWh * 1000) / 1000 }, { loadId: load.id })
      .catch(e => this.error(e));
    this.loadDevice(load.id)?.onStop(kWh, Math.round(activationW(a)));
  }

  private loadDevice(loadId: string): { onStart(w: number): void; onStop(kWh: number, w: number): void } | null {
    try {
      const dev = this.homey.drivers.getDriver('load').getDevices().find(d => d.getData()?.loadId === loadId);
      return (dev as unknown as { onStart(w: number): void; onStop(kWh: number, w: number): void }) ?? null;
    } catch {
      return null;
    }
  }

  // ---- metered devices and prices ------------------------------------------------------------

  private async trackDevices(): Promise<void> {
    if (!this.api || !this.meterId) await this.connect();
    const now = Date.now();
    const devices = await this.devices();
    const own = new Set(devices.filter(d => d.driverId?.includes('com.decline27.powerdetective')).map(d => d.id));
    if (this.meterId) own.add(this.meterId);
    this.refs.update(now, devices, own);
    const priced = devices.find(d => PRICE_CAPABILITIES.some(c => typeof d.capabilitiesObj?.[c]?.value === 'number'));
    if (priced) {
      const cap = PRICE_CAPABILITIES.find(c => typeof priced.capabilitiesObj?.[c]?.value === 'number') as string;
      this.prices.record(now, priced.capabilitiesObj![cap]!.value as number);
    }
  }

  // ---- analysis, findings, summary -------------------------------------------------------------

  userSettings(): UserSettings {
    const s = this.homey.settings;
    const num = (k: string, d: number | null) => (Number.isFinite(Number(s.get(k))) && s.get(k) !== null && s.get(k) !== '' ? Number(s.get(k)) : d);
    return {
      names: (s.get(SETTINGS.names) as Record<string, string>) ?? {},
      experiments: ((s.get(SETTINGS.experiments) as Experiment[]) ?? []).slice(-20),
      currency: s.get(SETTINGS.currency) || 'SEK',
      flatPrice: num(SETTINGS.flatPrice, null),
      cop: Math.min(8, Math.max(1, num(SETTINGS.cop, 3) as number)),
      timeZone: this.timeZone,
    };
  }

  async refresh(): Promise<Analysis> {
    const now = Date.now();
    this.analysis = analyse(this.engine, this.refs.references(), this.refs.heatPumpIds(), this.prices, this.userSettings(), now);
    for (const f of this.analysis.findings) {
      if (this.findingsSeen.has(f.id)) continue;
      this.findingsSeen.add(f.id);
      await this.homey.flow
        .getTriggerCard('finding_new')
        .trigger({ title: f.title, saving: Math.round(f.savingPerMonth ?? f.costPerMonth ?? 0) })
        .catch(e => this.error(e));
    }
    this.keepTestResults();
    this.syncDevices();
    if (now - this.summaryAt > SUMMARY_EVERY_MS && this.analysis.observedHours >= 24 * 7) await this.writeSummary(true);
    return this.analysis;
  }

  /** Stores a test's verdict once it has ended, so it no longer depends on data that ages out. */
  private keepTestResults(): void {
    const list = (this.homey.settings.get(SETTINGS.experiments) as Experiment[]) ?? [];
    let changed = false;
    const next = list.map(e => {
      if (e.result && e.result.status !== 'running') return e;
      const v = this.analysis?.experiments.find(x => x.id === e.id);
      if (!v || v.status === 'running') return e;
      changed = true;
      const { status, expected, observed, pValue, text } = v;
      return { ...e, result: { status, expected, observed, pValue, text } };
    });
    if (changed) this.homey.settings.set(SETTINGS.experiments, next);
  }

  /** Load devices follow the analysis: a run whose stop was missed does not stay on. */
  private syncDevices(): void {
    let devices: Homey.Device[] = [];
    try {
      devices = this.homey.drivers.getDriver('load').getDevices();
    } catch {
      return;
    }
    for (const d of devices) {
      const load = this.analysis?.loads.find(l => l.id === d.getData()?.loadId);
      if (!load || load.running) continue;
      if (d.getCapabilityValue('load_running') !== false) d.setCapabilityValue('load_running', false).catch(e => this.error(e));
      if (d.getCapabilityValue('measure_power') !== 0) d.setCapabilityValue('measure_power', 0).catch(e => this.error(e));
    }
  }

  /** Whether a load is running now, from the live starts (not the last analysis). */
  isRunning(loadId: string): boolean {
    if (!this.analysis) return false;
    const now = Date.now();
    return this.engine
      .running()
      .some(st => classify({ start: st.t, end: Math.max(st.t, now), delta: st.delta }, this.analysis!.clusters)?.id === loadId);
  }

  async writeSummary(notify: boolean): Promise<{ text: string; source: string; error?: string }> {
    const a = this.analysis ?? (await this.refresh());
    const s = this.homey.settings;
    const days = a.days.filter(d => d.coveredHours > 0);
    const total = days.reduce((x, d) => x + d.totalKWh, 0);
    const explained = days.reduce((x, d) => x + d.explainedShare * d.totalKWh, 0);
    const input: SummaryInput = {
      language: s.get(SETTINGS.language) === 'sv' ? 'sv' : 'en',
      currency: this.userSettings().currency,
      days: days.length,
      totalKWh: total,
      explainedShare: total > 0 ? explained / total : 0,
      loads: a.loads.slice(0, 8).map(l => ({ name: displayName(l), kWhPerDay: l.kWhPerDay, costPerMonth: l.costPerMonth, confirmed: l.source !== null })),
      findings: a.findings.slice(0, 5),
      validation: a.validation.map(v => ({ device: v.device, f1: v.score.f1 })),
    };
    const res = await summarize(input, { apiKey: s.get(SETTINGS.apiKey) || undefined, model: s.get(SETTINGS.model) || undefined });
    this.summaryAt = Date.now();
    s.set(SETTINGS.summary, { ...res, at: this.summaryAt });
    if (notify) await this.homey.notifications.createNotification({ excerpt: `Power Detective: ${res.text}`.slice(0, 1000) }).catch(e => this.error(e));
    return res;
  }

  /** Everything the settings page shows. */
  async view() {
    const a = this.analysis ?? (await this.refresh());
    const { clusters: _clusters, ...rest } = a;
    void _clusters;
    return {
      ...rest,
      status: this.status,
      meter: this.meterName,
      summary: this.homey.settings.get(SETTINGS.summary) ?? null,
      settings: { ...this.userSettings(), apiKeySet: !!this.homey.settings.get(SETTINGS.apiKey) },
    };
  }

  // ---- user actions ----------------------------------------------------------------------------

  setName(loadId: string, name: string): void {
    const names = { ...((this.homey.settings.get(SETTINGS.names) as Record<string, string>) ?? {}) };
    if (name.trim()) names[loadId] = name.trim().slice(0, 60);
    else delete names[loadId];
    this.homey.settings.set(SETTINGS.names, names);
  }

  startExperiment(loadId: string, label: string, hours?: number): Experiment {
    const load = this.analysis?.loads.find(l => l.id === loadId);
    const rate = load ? load.startsPerDay / 24 : 0;
    const exp: Experiment = {
      id: `${loadId}-${Date.now()}`,
      loadId,
      label: label.trim().slice(0, 60) || 'what you switched off',
      startedAt: Date.now(),
      hours: hours && hours > 0 ? Math.min(48, hours) : hoursNeeded(rate),
      rate,
    };
    const list = ((this.homey.settings.get(SETTINGS.experiments) as Experiment[]) ?? []).concat(exp).slice(-20);
    this.homey.settings.set(SETTINGS.experiments, list);
    return exp;
  }

  loadsForAutocomplete(query: string) {
    const q = query.toLowerCase();
    return (this.analysis?.loads ?? [])
      .map(l => ({ id: l.id, name: displayName(l), description: `${l.phases}, ${Math.round(l.kWhPerDay * 10) / 10} kWh/day` }))
      .filter(x => x.name.toLowerCase().includes(q));
  }

  pairableLoads() {
    return (this.analysis?.loads ?? []).map(l => ({ name: displayName(l), data: { id: l.id, loadId: l.id } }));
  }

  private registerFlows(): void {
    const auto = async (query: string) => this.loadsForAutocomplete(query);
    this.homey.flow.getTriggerCard('load_started').registerRunListener(async (args, state) => !args.load || args.load.id === state.loadId);
    (this.homey.flow.getTriggerCard('load_started') as any).registerArgumentAutocompleteListener?.('load', auto);
    this.homey.flow.getTriggerCard('load_stopped').registerRunListener(async (args, state) => !args.load || args.load.id === state.loadId);
    (this.homey.flow.getTriggerCard('load_stopped') as any).registerArgumentAutocompleteListener?.('load', auto);
    this.homey.flow
      .getConditionCard('load_running')
      .registerArgumentAutocompleteListener('load', auto)
      .registerRunListener(async args => this.isRunning(args.load.id));
    this.homey.flow
      .getActionCard('start_test')
      .registerArgumentAutocompleteListener('load', auto)
      .registerRunListener(async args => {
        this.startExperiment(args.load.id, args.label ?? '', Number(args.hours) || undefined);
        return true;
      });
  }

  // ---- persistence -----------------------------------------------------------------------------

  private load(): SavedState | null {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as SavedState;
    } catch {
      return null;
    }
  }

  private save(): void {
    try {
      const state: SavedState = {
        engine: this.engine.snapshot(),
        refs: this.refs.snapshot(),
        prices: this.prices.snapshot(),
        findingsSeen: [...this.findingsSeen].slice(-500),
        summaryAt: this.summaryAt,
      };
      fs.writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state));
      fs.renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
    } catch (e) {
      this.error('Saving state failed', e);
    }
  }
};
