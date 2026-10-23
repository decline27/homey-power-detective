/**
 * Everything the settings page, the devices and the flows show, worked out from the engine, the
 * metered devices and the prices. Pure: the app calls it every few minutes.
 */
import { classify } from '../engine/clustering';
import { PowerEngine } from '../engine/engine';
import { LabelMatch, Reference, matchReferences, silentStretches } from '../engine/labels';
import { Score } from '../engine/score';
import { CLUSTERING } from '../engine/config';
import { Activation, LoadCluster, Vec3, activationW } from '../engine/types';
import { Experiment, ExperimentResult, evaluateExperiment } from '../insight/experiments';
import { Finding, buildFindings } from '../insight/findings';
import { DayRecord } from '../engine/day-meter';
import { AccountInput, DayAccount, buildAccount } from '../insight/account';
import { Session, inRhythmSlot, kindLabel, sessionsOf } from '../insight/appliances';
import { DayLedger, activationEnergy, buildDayLedger } from '../insight/ledger';
import { dayBounds } from '../insight/time';
import { HeatingSignature, TemperatureBook, heatingSignature } from '../insight/weather';
import { METERED, MeteredDevices, MeteredStatus } from './metered';
import { PriceBook } from './prices';

export const ANALYSIS = {
  /** Loads are learned over this many days. */
  WINDOW_DAYS: 14,
  /** Days shown in the ledger. */
  LEDGER_DAYS: 7,
  /** MELCloud and similar report a run a few minutes late (ms). */
  REFERENCE_TOL_MS: 6 * 60_000,
  /** A load whose runs are at least this share metered devices' runs is named after them. */
  METERED_RUN_SHARE: 0.8,
  /** A load tied to a device keeps it while this share of its runs still start with the device's... */
  KEEP_PRECISION: 0.5,
  /** ...over at least this many of them. */
  KEEP_MIN_MATCHES: 3,
  /** An unnamed load whose runs are at least this share one appliance's pattern is suggested as it. */
  APPLIANCE_RUN_SHARE: 0.6,
};

export interface UserSettings {
  /** Names the user gave, by load id. */
  names: Record<string, string>;
  experiments: Experiment[];
  currency: string;
  flatPrice: number | null;
  cop: number;
  timeZone: string;
}

export interface LoadView {
  id: string;
  name: string | null;
  /** Where the name came from. */
  source: 'user' | 'device' | 'test' | null;
  device: string | null;
  /** The metered device the load was matched to, if any. */
  deviceId: string | null;
  score: Score | null;
  phases: string;
  medianW: number;
  medianMinutes: number;
  periodMinutes: number | null;
  rhythmic: boolean;
  startsPerDay: number;
  kWhPerDay: number;
  costPerMonth: number | null;
  running: boolean;
  count: number;
  /** The appliance its runs look like (a typical pattern, unconfirmed), when it has no name. */
  suggestion: string | null;
}

/** An appliance recognised by the pattern of its sessions, not yet confirmed by the user. */
export interface ApplianceView {
  label: string;
  phases: string;
  sessions: number;
  lastStart: number;
  kWhPerSession: number;
  /** What the latest session looked like. */
  reason: string;
  /** Found loads whose runs these sessions mostly are. */
  loadIds: string[];
}

export interface ExperimentView extends Experiment, ExperimentResult {
  loadName: string;
}

export interface Analysis {
  at: number;
  observedHours: number;
  loads: LoadView[];
  findings: Finding[];
  days: DayLedger[];
  validation: Array<{ device: string; loads: string[]; score: Score }>;
  experiments: ExperimentView[];
  avgPrice: number | null;
  /** Every kWh of each day, in one row: meters, found loads, always-on, heating, unexplained. */
  accounts: DayAccount[];
  /** What was learned about each metered device. */
  metered: MeteredStatus[];
  /** kWh per degree-day of otherwise unexplained energy, once the data show it. */
  heating: HeatingSignature | null;
  /** Appliances recognised by pattern among the runs nothing else explains. */
  appliances: ApplianceView[];
  /** Device each load is tied to by timing, by load id: kept for the next analysis (hysteresis). */
  deviceMatches: Record<string, string>;
  /** The clusters themselves, for the live classification. */
  clusters: LoadCluster[];
}

/** What the app knows beyond the engine: the raw house meter, the metered devices, the weather. */
export interface Sources {
  /** Whole-house days from the raw meter (the engine sees what the live devices leave). */
  house?: DayRecord[];
  metered?: MeteredDevices;
  temps?: TemperatureBook;
  /** The previous analysis's `deviceMatches`. */
  deviceMatches?: Record<string, string>;
}

const HEAT_PUMP_NAME = /heat ?pump|värmepump|varmepump|ecodan|nibe|thermia/i;

/**
 * Loads running now: the open starts, each with the load it is. A start older than its load's
 * longest plausible run is a missed stop, not a load still running.
 */
export function runningNow(engine: PowerEngine, clusters: LoadCluster[], now: number): Array<{ t: number; w: number; cluster: LoadCluster | null }> {
  return engine
    .running()
    .map(st => ({ st, cluster: classify({ start: st.t, end: Math.max(st.t, now), delta: st.delta }, clusters, undefined, true) }))
    .filter(x => !x.cluster || now - x.st.t <= x.cluster.maxMinutes * 60_000)
    .map(x => ({ t: x.st.t, w: x.st.delta[0] + x.st.delta[1] + x.st.delta[2], cluster: x.cluster }));
}

export function displayName(v: { name: string | null; phases: string; medianW: number; suggestion?: string | null }): string {
  if (v.name) return v.name;
  return v.suggestion ? `${v.suggestion} (likely)` : `${Math.round(v.medianW / 10) * 10} W on ${v.phases}`;
}

/**
 * Device matches: first as the device's own runs; then the loads left, as parts of a device's
 * programme (a dishwasher's heater, a modulating heat pump's boost), also of a device already
 * matched. A load is only tied to a device when its matches would be unlikely by chance (p ≤ 0.02).
 */
export function nameFromDevices(loads: LoadCluster[], refs: Reference[], keep: Record<string, string> = {}): LabelMatch[] {
  const directOpts = { tolMs: ANALYSIS.REFERENCE_TOL_MS, gapMs: 2 * 60_000, maxDurationRatio: 3 };
  const direct = matchReferences(loads, refs, { ...directOpts, alpha: 0.02 });
  const usedLoads = new Set(direct.flatMap(m => m.clusterIds));
  const programmes = matchReferences(
    loads.filter(l => !usedLoads.has(l.id)),
    refs,
    { tolMs: 10 * 60_000, gapMs: 45 * 60_000, maxDurationRatio: Infinity, minPrecision: 0.8, alpha: 0.02, parts: true }
  );
  const found = [...direct, ...programmes];
  // Hysteresis: a load once tied to a device stays tied while its runs still mostly start with the
  // device's. MELCloud polls every 5 min and misses short compressor runs, so the heat pump's
  // precision sits at the naming threshold and would otherwise flip in and out.
  const named = new Set(found.flatMap(m => m.clusterIds));
  const kept = Object.entries(keep).flatMap(([loadId, refId]) => {
    const load = loads.find(l => l.id === loadId);
    const ref = refs.find(r => r.id === refId);
    if (named.has(loadId) || !load || !ref) return [];
    const [m] = matchReferences([load], [ref], { ...directOpts, minPrecision: ANALYSIS.KEEP_PRECISION, minF1: 0 });
    return m && m.score.tp >= ANALYSIS.KEEP_MIN_MATCHES ? [m] : [];
  });
  return [...found, ...kept];
}

/**
 * The metered device a run is, when one switched on with it on the same phases. Its own meter
 * already counts that energy. Runs, not loads: one load can be two devices of a size on one phase
 * (a spa heater and a space heater), so neither device's timing names the load as a whole.
 */
export function meteredRunOf(
  refs: Reference[],
  shares: Map<string, Vec3>
): (a: Activation) => string | null {
  const devices = refs.filter(r => shares.has(r.id));
  return a => {
    const w = activationW(a);
    if (w <= 0) return null;
    const own = a.delta.map(x => Math.max(0, x) / w);
    for (const r of devices) {
      const share = shares.get(r.id) as Vec3;
      if (own.reduce((s, x, k) => s + Math.abs(x - share[k]), 0) > CLUSTERING.MAX_SHARE_DISTANCE) continue;
      if (r.intervals.some(i => Math.abs(i.start - a.start) <= ANALYSIS.REFERENCE_TOL_MS)) return r.id;
    }
    return null;
  };
}

export function analyse(
  engine: PowerEngine,
  refs: Reference[],
  heatPumpDeviceIds: string[],
  prices: PriceBook,
  s: UserSettings,
  now: number,
  sources: Sources = {}
): Analysis {
  const from = now - ANALYSIS.WINDOW_DAYS * 86_400_000;
  const clusters = engine.loads(from, now);
  // A device subtracted live is not in what detection sees: it cannot name a load there.
  const live = new Set((sources.metered?.status() ?? []).filter(m => m.live).map(m => m.id));
  const matches = nameFromDevices(
    clusters,
    refs.filter(r => !live.has(r.id)).map(r => ({ ...r, silent: silentStretches(r.intervals, now) })),
    sources.deviceMatches
  );
  const byLoad = new Map<string, LabelMatch>();
  matches.forEach(m => m.clusterIds.forEach(id => byLoad.set(id, m)));

  // A test the user ran and passed names the load as well.
  const tests = s.experiments.map(e => {
    if (e.result && e.result.status !== 'running') return { e, r: e.result };
    const load = clusters.find(c => c.id === e.loadId);
    const before = load ? load.activations.filter(a => a.start < e.startedAt && a.start >= e.startedAt - 7 * 86_400_000) : [];
    const observedFrom = Math.max(engine.observedFrom() ?? e.startedAt, e.startedAt - 7 * 86_400_000);
    const hoursBefore = Math.max(1, (e.startedAt - observedFrom) / 3_600_000);
    const end = e.startedAt + e.hours * 3_600_000;
    const during = engine
      .allActivations()
      .filter(a => a.start >= e.startedAt && a.start < end && classify(a, clusters)?.id === e.loadId).length;
    return { e, r: evaluateExperiment(e, now, e.rate ?? before.length / hoursBefore, during) };
  });
  const confirmedBy = new Map(tests.filter(t => t.r.status === 'confirmed').map(t => [t.e.loadId, t.e.label]));

  const avgPrice = prices.average(from, now, s.flatPrice);
  const running = new Set(
    runningNow(engine, clusters, now)
      .map(x => x.cluster?.id)
      .filter((id): id is string => !!id)
  );

  // Runs that a metered device is (its phases learned from the house meter, so the check is real).
  const shares = new Map(
    (sources.metered?.status() ?? []).filter(m => m.share && m.matches >= METERED.MIN_MATCHES).map(m => [m.id, m.share as Vec3])
  );
  const meteredRun = meteredRunOf(refs, shares);
  const runDevices = new Map(clusters.map(c => [c.id, c.activations.map(meteredRun)]));
  const refName = new Map(refs.map(r => [r.id, r.name]));
  /** The devices a load's runs mostly are, when no single device's timing named it. */
  const meteredBy = (c: LoadCluster): { name: string; id: string } | null => {
    const ids = runDevices.get(c.id) ?? [];
    const hits = ids.filter((id): id is string => id !== null);
    if (!ids.length || hits.length / ids.length < ANALYSIS.METERED_RUN_SHARE) return null;
    const counts = new Map<string, number>();
    hits.forEach(id => counts.set(id, (counts.get(id) ?? 0) + 1));
    const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    return { name: byCount.map(id => refName.get(id) ?? id).join(' / '), id: byCount[0] };
  };

  // Appliances by pattern, among the runs nothing explains yet: not a thermostat's (all day, on a
  // rhythm), not a metered device's, not a load a device already named.
  const explained = new Set<Activation>();
  for (const c of clusters) {
    const ids = runDevices.get(c.id) ?? [];
    c.activations.forEach((a, i) => {
      if (c.rhythmic || byLoad.has(c.id) || ids[i]) explained.add(a);
    });
  }
  const rhythmic = clusters.filter(c => c.rhythmic);
  const sessions = sessionsOf(
    engine
      .allActivations()
      .filter(a => a.start >= from && a.start < now && !explained.has(a) && !meteredRun(a) && !inRhythmSlot(a, rhythmic)),
    { now, open: engine.running() }
  ).filter(x => x.kinds.length && x.finished);
  const sessionOf = new Map<Activation, Session>();
  sessions.forEach(x => x.activations.forEach(a => sessionOf.set(a, x)));
  /** The pattern most of a load's runs fit, when they fit one. */
  const suggestionFor = (c: LoadCluster): string | null => {
    const labels = c.activations.map(a => sessionOf.get(a)).map(x => (x ? kindLabel(x.kinds) : null));
    const counts = new Map<string, number>();
    labels.forEach(l => l && counts.set(l, (counts.get(l) ?? 0) + 1));
    const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return top && top[1] / c.activations.length >= ANALYSIS.APPLIANCE_RUN_SHARE ? top[0] : null;
  };

  const loads: LoadView[] = clusters.map(c => {
    const m = byLoad.get(c.id);
    const mb = m ? null : meteredBy(c);
    const user = s.names[c.id];
    const name = user ?? confirmedBy.get(c.id) ?? m?.referenceName ?? mb?.name ?? null;
    return {
      id: c.id,
      name,
      source: user ? 'user' : confirmedBy.has(c.id) ? 'test' : m || mb ? 'device' : null,
      device: m?.referenceName ?? mb?.name ?? null,
      deviceId: m?.referenceId ?? mb?.id ?? null,
      score: m?.score ?? null,
      phases: c.phases,
      medianW: c.medianW,
      medianMinutes: c.medianMinutes,
      periodMinutes: c.periodMinutes,
      rhythmic: c.rhythmic,
      startsPerDay: c.startsPerDay,
      kWhPerDay: c.kWhPerDay,
      costPerMonth: avgPrice === null ? null : c.kWhPerDay * 30 * avgPrice,
      running: running.has(c.id),
      count: c.count,
      suggestion: name ? null : suggestionFor(c),
    };
  });

  const clustered = new Set(clusters.flatMap(c => c.activations));
  const loadsOfLabel = (label: string) => loads.filter(l => l.suggestion === label).map(l => l.id);
  const byLabel = new Map<string, Session[]>();
  sessions.forEach(x => byLabel.set(kindLabel(x.kinds), [...(byLabel.get(kindLabel(x.kinds)) ?? []), x]));
  const appliances: ApplianceView[] = [...byLabel.entries()]
    .map(([label, xs]) => {
      const last = xs[xs.length - 1];
      return {
        label,
        phases: last.phases,
        sessions: xs.length,
        lastStart: last.start,
        kWhPerSession: xs.reduce((t, x) => t + x.kWh, 0) / xs.length,
        reason: last.reason,
        loadIds: loadsOfLabel(label),
      };
    })
    .sort((a, b) => b.kWhPerSession * b.sessions - a.kWhPerSession * a.sessions);
  /** Energy of recognised runs that no found load holds, per label, on one day. */
  const applianceKWh = (date: string): Array<{ label: string; kWh: number }> => {
    const b = dayBounds(date, s.timeZone);
    const out = new Map<string, number>();
    for (const x of sessions) {
      for (const a of x.activations) {
        if (clustered.has(a)) continue;
        const kWh = activationEnergy(a, b.start, b.end).kWh;
        if (kWh > 0) out.set(kindLabel(x.kinds), (out.get(kindLabel(x.kinds)) ?? 0) + kWh);
      }
    }
    return [...out.entries()].map(([label, kWh]) => ({ label, kWh }));
  };

  const names = Object.fromEntries(loads.filter(l => l.name).map(l => [l.id, l.name as string]));
  const heatPumpLoadIds = loads
    .filter(l => (byLoad.get(l.id) && heatPumpDeviceIds.includes(byLoad.get(l.id)!.referenceId)) || (l.name && HEAT_PUMP_NAME.test(l.name)))
    .map(l => l.id);

  const allDays = engine.days().map(d => buildDayLedger(d, clusters, dayBounds(d.date, s.timeZone), prices.priceAt(s.flatPrice)));
  const days = allDays.slice(-ANALYSIS.LEDGER_DAYS);
  // The account counts a metered device's runs once, by its own meter: not again as a load.
  const unmetered = clusters.map(c => {
    const ids = runDevices.get(c.id) ?? [];
    return { ...c, activations: c.activations.filter((_, i) => !ids[i]) };
  });
  const accountDays = engine.days().map(d => buildDayLedger(d, unmetered, dayBounds(d.date, s.timeZone), prices.priceAt(s.flatPrice)));
  // The account: the house meter's day, the device meters, the residual's loads and base.
  const loadName = new Map(loads.map(l => [l.id, displayName(l)]));
  const accountInput = (l: DayLedger): AccountInput => {
    const h = sources.house?.find(x => x.date === l.date);
    return {
      date: l.date,
      totalKWh: h ? h.kWh : l.totalKWh,
      coveredHours: h ? h.coveredMs / 3_600_000 : l.coveredHours,
      metered: sources.metered?.energyOn(l.date) ?? [],
      alwaysOnKWh: l.baseloadKWh,
      alwaysOnW: l.baseloadW,
      loads: [
        ...l.loads.map(r => ({ loadId: r.loadId, name: loadName.get(r.loadId) ?? r.loadId, kWh: r.kWh, deviceId: byLoad.get(r.loadId)?.referenceId ?? null })),
        // Seen too seldom to be a load yet, but shaped like an appliance.
        ...applianceKWh(l.date).map(x => ({ loadId: `appliance:${x.label}`, name: `${x.label} (likely)`, kWh: x.kWh, deviceId: null })),
      ],
      weatherKWh: null,
    };
  };
  const hddOf = (date: string) => sources.temps?.degreeDays(dayBounds(date, s.timeZone)) ?? null;
  const points = accountDays
    .map(l => buildAccount(accountInput(l)))
    .filter(a => a.coveredHours >= 20)
    // What meters and found loads leave (always-on and unexplained) is what the weather may explain.
    .map(a => ({ hdd: hddOf(a.date), kWh: a.rows.filter(r => r.kind === 'unexplained' || r.kind === 'always_on').reduce((x, r) => x + r.kWh, 0) }))
    .filter((p): p is { hdd: number; kWh: number } => p.hdd !== null);
  const heating = heatingSignature(points);
  const accounts = accountDays.slice(-ANALYSIS.LEDGER_DAYS).map(l => {
    const hdd = hddOf(l.date);
    return buildAccount({ ...accountInput(l), weatherKWh: heating && hdd !== null ? heating.slope * hdd : null });
  });

  // Base load from the account's last complete day (today is partial): always-on after the
  // weather took its share, so winter heating running all day is not called standby.
  const fullAccounts = accounts.filter(d => d.coveredHours >= 20);
  const baseloadW = fullAccounts.length ? fullAccounts[fullAccounts.length - 1].alwaysOnW : accounts[accounts.length - 1]?.alwaysOnW ?? null;

  const findings = buildFindings({
    loads: clusters,
    names,
    heatPumpLoadIds,
    baseloadW,
    baseloadFullDay: fullAccounts.length > 0,
    avgPrice,
    currency: s.currency,
    price: prices.priceAt(s.flatPrice),
    heatPumpCop: s.cop,
    timeZone: s.timeZone,
  });

  const observedHours = engine.observedFrom() === null ? 0 : (now - (engine.observedFrom() as number)) / 3_600_000;
  return {
    at: now,
    observedHours,
    loads,
    findings,
    days,
    // One row per device: its direct match (the programme parts only add names).
    validation: matches
      .filter((m, i) => matches.findIndex(x => x.referenceId === m.referenceId) === i)
      .map(m => ({ device: m.referenceName, loads: m.clusterIds, score: m.score })),
    experiments: tests.map(({ e, r }) => {
      const l = loads.find(x => x.id === e.loadId);
      return { ...e, ...r, loadName: l ? displayName(l) : e.loadId };
    }),
    avgPrice,
    accounts,
    metered: sources.metered?.status() ?? [],
    heating,
    appliances,
    deviceMatches: Object.fromEntries([...byLoad.entries()].map(([id, m]) => [id, m.referenceId])),
    clusters,
  };
}
