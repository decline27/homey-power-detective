/**
 * Appliances by the shape of a session, for a house with nothing but its meter: the heating
 * element is what the meter sees of a dishwasher, a washing machine, a tumble dryer or an oven
 * (motors and pumps draw less than the smallest step), and each heats in its own pattern:
 *
 *   dishwasher        two heats of 4-30 min, 15-100 min apart (main wash, then rinse or drying)
 *   washing machine   one heat of 6-35 min at the start; the rest is motor
 *   tumble dryer      a condenser dryer's element cycling on its thermostat for 40-200 min
 *   oven              one long heat-up, then short thermostat cycles
 *   kettle            one 1.6-3.2 kW run of 1-5 min
 *   microwave/toaster one 0.7-1.6 kW run of 1-8 min
 *
 * These are typical patterns, not learned from this house: every match is a suggestion the user
 * confirms (by naming the load), and a session that fits two patterns says so.
 */
import { phaseLabel, phaseShare } from '../engine/clustering';
import { Activation, LoadCluster, activationKWh, activationW } from '../engine/types';

export const APPLIANCES = {
  /** A run this big (W) is a heating element. */
  MIN_ELEMENT_W: 800,
  /** Element runs on the same phases closer than this belong to one session (ms). */
  SESSION_GAP_MS: 75 * 60_000,
  /** A run at least this long is a heat, not a burst (minutes). */
  HEAT_MIN: 4,
};

export type ApplianceKind = 'dishwasher' | 'washing_machine' | 'tumble_dryer' | 'oven' | 'kettle' | 'microwave';

export const APPLIANCE_NAMES: Record<ApplianceKind, string> = {
  dishwasher: 'Dishwasher',
  washing_machine: 'Washing machine',
  tumble_dryer: 'Tumble dryer',
  oven: 'Oven',
  kettle: 'Kettle',
  microwave: 'Microwave or toaster',
};

export interface Session {
  start: number;
  end: number;
  phases: string;
  activations: Activation[];
  kWh: number;
  /** Every pattern the session fits; empty when none does. */
  kinds: ApplianceKind[];
  /** What the session looked like, in words. */
  reason: string;
}

const minutes = (a: Activation) => (a.end - a.start) / 60_000;
const inRange = (x: number, lo: number, hi: number) => x >= lo && x <= hi;
const round = (x: number) => Math.round(x);

/** Element runs grouped into sessions per phase set (the caller leaves out what is explained). */
export function sessionsOf(activations: Activation[], cfg = APPLIANCES): Session[] {
  const byPhases = new Map<string, Activation[]>();
  for (const a of activations) {
    if (activationW(a) < cfg.MIN_ELEMENT_W || a.end <= a.start) continue;
    const key = phaseLabel(phaseShare(a.delta));
    byPhases.set(key, [...(byPhases.get(key) ?? []), a]);
  }
  const out: Session[] = [];
  for (const [phases, acts] of byPhases) {
    acts.sort((x, y) => x.start - y.start);
    let cur: Activation[] = [];
    const close = () => {
      if (cur.length) out.push(describe(phases, cur));
      cur = [];
    };
    for (const a of acts) {
      if (cur.length && a.start - Math.max(...cur.map(x => x.end)) > cfg.SESSION_GAP_MS) close();
      cur.push(a);
    }
    close();
  }
  return out.sort((x, y) => x.start - y.start);
}

function describe(phases: string, acts: Activation[]): Session {
  const start = acts[0].start;
  const end = Math.max(...acts.map(a => a.end));
  // Each of these appliances is on one phase; a 3-phase run of their size is a heat pump or a heater.
  const { kinds, reason } = /^L\d$/.test(phases) ? recognise(acts) : { kinds: [], reason: '' };
  return { start, end, phases, activations: acts, kWh: acts.reduce((s, a) => s + activationKWh(a), 0), kinds, reason };
}

/** The patterns a session's element runs fit. */
export function recognise(acts: Activation[], cfg = APPLIANCES): { kinds: ApplianceKind[]; reason: string } {
  const kinds: ApplianceKind[] = [];
  const kW = (a: Activation) => activationW(a) / 1000;
  const heats = acts.filter(a => minutes(a) >= cfg.HEAT_MIN);
  const span = (Math.max(...acts.map(a => a.end)) - acts[0].start) / 60_000;
  const big = (a: Activation) => inRange(kW(a), 1.5, 2.8);
  let reason = `${acts.length} element run${acts.length > 1 ? 's' : ''} over ${round(span)} min`;

  if (acts.length === 1) {
    const a = acts[0];
    const m = minutes(a);
    reason = `one ${kW(a).toFixed(1)} kW run of ${round(m)} min`;
    if (inRange(kW(a), 1.6, 3.2) && inRange(m, 1, 5)) kinds.push('kettle');
    if (inRange(kW(a), 0.7, 1.6) && inRange(m, 1, 8)) kinds.push('microwave');
    if (big(a) && inRange(m, 6, 35)) kinds.push('washing_machine');
    return { kinds, reason };
  }

  if (heats.length === 2 && acts.length <= 4 && heats.every(big) && heats.every(a => minutes(a) <= 30)) {
    const [h1, h2] = heats;
    const gap = (h2.start - h1.end) / 60_000;
    const similar = Math.abs(kW(h1) - kW(h2)) <= 0.25 * Math.max(kW(h1), kW(h2));
    if (similar && inRange(gap, 15, 100)) {
      kinds.push('dishwasher');
      reason = `two ${kW(h1).toFixed(1)} kW heats of ${round(minutes(h1))} and ${round(minutes(h2))} min, ${round(gap)} min apart`;
    }
  }
  if (heats.length === 1 && acts.length <= 2 && big(heats[0]) && inRange(minutes(heats[0]), 6, 35)) {
    kinds.push('washing_machine');
    reason = `one ${kW(heats[0]).toFixed(1)} kW heat of ${round(minutes(heats[0]))} min`;
  }
  const onMin = acts.reduce((s, a) => s + minutes(a), 0);
  if (acts.length >= 4 && acts.every(a => inRange(kW(a), 1.2, 3)) && inRange(span, 40, 200) && onMin >= 25) {
    kinds.push('tumble_dryer');
    reason = `a ${kW(acts[0]).toFixed(1)} kW element switching ${acts.length} times over ${round(span)} min`;
  }
  const rest = acts.slice(1);
  if (
    acts.length >= 3 &&
    acts.every(a => inRange(kW(a), 0.8, 3.5)) &&
    inRange(minutes(acts[0]), 6, 25) &&
    rest.filter(a => minutes(a) <= 10).length >= 0.75 * rest.length &&
    inRange(span, 15, 150)
  ) {
    kinds.push('oven');
    if (!kinds.includes('tumble_dryer')) reason = `a ${round(minutes(acts[0]))} min heat-up, then ${rest.length} short cycles over ${round(span)} min`;
  }
  return { kinds, reason };
}

/**
 * A thermostat load's run that started together with a smaller load and was seen as one bigger
 * run: it fills the gap in the rhythmic load's cycle (its runs one period before or after, none
 * near it), and what the rhythmic load does not explain is smaller than an element. Floor
 * heating starting with the heat pump looks like a 2 kW washing machine heat otherwise.
 */
export function inRhythmSlot(a: Activation, rhythmic: LoadCluster[], cfg = APPLIANCES): boolean {
  for (const c of rhythmic) {
    if (!c.periodMinutes) continue;
    const period = c.periodMinutes * 60_000;
    const near = (t: number, tol: number) => c.activations.some(x => x !== a && Math.abs(x.start - t) <= tol);
    const slot = near(a.start - period, 0.1 * period) || near(a.start + period, 0.1 * period);
    if (!slot || near(a.start, 0.5 * period)) continue;
    const rest = a.delta.map((d, k) => d - c.medianW * c.share[k]);
    if (rest.reduce((s, x) => s + Math.max(0, x), 0) < cfg.MIN_ELEMENT_W) return true;
  }
  return false;
}

export function kindLabel(kinds: ApplianceKind[]): string {
  return kinds.map((k, i) => (i === 0 ? APPLIANCE_NAMES[k] : APPLIANCE_NAMES[k].toLowerCase())).join(' or ');
}
