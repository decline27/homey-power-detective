/**
 * Everything the settings page, the devices and the flows show, worked out from the engine, the
 * metered devices and the prices. Pure: the app calls it every few minutes.
 */
import { classify } from '../engine/clustering';
import { PowerEngine } from '../engine/engine';
import { LabelMatch, Reference, matchReferences } from '../engine/labels';
import { Score } from '../engine/score';
import { LoadCluster } from '../engine/types';
import { Experiment, ExperimentResult, evaluateExperiment } from '../insight/experiments';
import { Finding, buildFindings } from '../insight/findings';
import { DayLedger, buildDayLedger } from '../insight/ledger';
import { dayBounds } from '../insight/time';
import { PriceBook } from './prices';

export const ANALYSIS = {
  /** Loads are learned over this many days. */
  WINDOW_DAYS: 14,
  /** Days shown in the ledger. */
  LEDGER_DAYS: 7,
  /** MELCloud and similar report a run a few minutes late (ms). */
  REFERENCE_TOL_MS: 6 * 60_000,
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
  /** The clusters themselves, for the live classification. */
  clusters: LoadCluster[];
}

const HEAT_PUMP_NAME = /heat ?pump|värmepump|varmepump|ecodan|nibe|thermia/i;

export function displayName(v: { name: string | null; phases: string; medianW: number }): string {
  return v.name ?? `${Math.round(v.medianW / 10) * 10} W on ${v.phases}`;
}

/** Device matches: first as the device's own runs, then, for what is left, as parts of a programme. */
export function nameFromDevices(loads: LoadCluster[], refs: Reference[]): LabelMatch[] {
  const direct = matchReferences(loads, refs, { tolMs: ANALYSIS.REFERENCE_TOL_MS, gapMs: 2 * 60_000, maxDurationRatio: 3 });
  const usedLoads = new Set(direct.flatMap(m => m.clusterIds));
  const usedRefs = new Set(direct.map(m => m.referenceId));
  const programmes = matchReferences(
    loads.filter(l => !usedLoads.has(l.id)),
    refs.filter(r => !usedRefs.has(r.id)),
    { tolMs: 10 * 60_000, gapMs: 45 * 60_000, maxDurationRatio: Infinity, minPrecision: 0.8 }
  );
  return [...direct, ...programmes];
}

export function analyse(
  engine: PowerEngine,
  refs: Reference[],
  heatPumpDeviceIds: string[],
  prices: PriceBook,
  s: UserSettings,
  now: number
): Analysis {
  const from = now - ANALYSIS.WINDOW_DAYS * 86_400_000;
  const clusters = engine.loads(from, now);
  const matches = nameFromDevices(clusters, refs);
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
    engine
      .running()
      .map(st => classify({ start: st.t, end: Math.max(st.t, now), delta: st.delta }, clusters)?.id)
      .filter((id): id is string => !!id)
  );

  const loads: LoadView[] = clusters.map(c => {
    const m = byLoad.get(c.id);
    const user = s.names[c.id];
    const name = user ?? confirmedBy.get(c.id) ?? m?.referenceName ?? null;
    return {
      id: c.id,
      name,
      source: user ? 'user' : confirmedBy.has(c.id) ? 'test' : m ? 'device' : null,
      device: m?.referenceName ?? null,
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
    };
  });

  const names = Object.fromEntries(loads.filter(l => l.name).map(l => [l.id, l.name as string]));
  const heatPumpLoadIds = loads
    .filter(l => (byLoad.get(l.id) && heatPumpDeviceIds.includes(byLoad.get(l.id)!.referenceId)) || (l.name && HEAT_PUMP_NAME.test(l.name)))
    .map(l => l.id);

  const days = engine
    .days()
    .slice(-ANALYSIS.LEDGER_DAYS)
    .map(d => buildDayLedger(d, clusters, dayBounds(d.date, s.timeZone), prices.priceAt(s.flatPrice)));
  // Base load from the last complete day (today is partial).
  const fullDays = days.filter(d => d.coveredHours >= 20);
  const baseloadW = fullDays.length ? fullDays[fullDays.length - 1].baseloadW : days[days.length - 1]?.baseloadW ?? null;

  const findings = buildFindings({
    loads: clusters,
    names,
    heatPumpLoadIds,
    baseloadW,
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
    validation: matches.map(m => ({ device: m.referenceName, loads: m.clusterIds, score: m.score })),
    experiments: tests.map(({ e, r }) => {
      const l = loads.find(x => x.id === e.loadId);
      return { ...e, ...r, loadName: l ? displayName(l) : e.loadId };
    }),
    avgPrice,
    clusters,
  };
}
