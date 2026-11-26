/**
 * Groups activations into loads by how they draw power: which phases, in what proportions, and
 * how much. Deterministic leader clustering (same input, same loads, same ids), then statistics
 * per load: typical power, run length, starts per day, energy per day and rhythm. A rhythmic load
 * (steady time between starts) is driven by a thermostat or a timer: floor heating, a water
 * heater, a fridge, a heat pump in mild weather.
 */
import { CLUSTERING } from './config';
import { Activation, LoadCluster, Vec3, activationKWh, activationW } from './types';

export type ClusteringConfig = typeof CLUSTERING;

export function phaseShare(delta: Vec3): Vec3 {
  const pos = delta.map(v => Math.max(0, v)) as Vec3;
  const total = pos[0] + pos[1] + pos[2];
  return total > 0 ? (pos.map(v => v / total) as Vec3) : [1 / 3, 1 / 3, 1 / 3];
}

export function phaseLabel(share: Vec3, threshold = CLUSTERING.PHASE_SHARE): string {
  const used = [0, 1, 2].filter(k => share[k] >= threshold);
  if (used.length === 3) return '3-phase';
  return used.map(k => `L${k + 1}`).join('+');
}

const shareDistance = (a: Vec3, b: Vec3) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface Group {
  share: Vec3;
  logW: number;
  members: Activation[];
}

/** Stable id from the load's signature, so a load keeps its id (and its name) across runs. */
export function clusterId(phases: string, medianW: number): string {
  const bucket = Math.round(Math.log(Math.max(medianW, 1)) / 0.1);
  return `${phases.replace(/\+/g, '')}-${bucket}`;
}

/** The time the activations were observed over; per-day figures divide by it. */
export interface Window {
  from: number;
  to: number;
}

const minutesOf = (a: Activation) => (a.end - a.start) / 60_000;

/** The value at quantile p of sorted values (lower of the two around it). */
const quantile = (sorted: number[], p: number) => sorted[Math.floor(p * (sorted.length - 1))];

export function clusterActivations(
  activations: Activation[],
  window?: Window,
  cfg: ClusteringConfig = CLUSTERING
): LoadCluster[] {
  const used = new Set<string>();
  return groupActivations(activations.filter(a => activationW(a) > 0 && a.end > a.start), cfg)
    .flatMap(g => splitBursts(g, cfg))
    .filter(g => g.members.length >= cfg.MIN_COUNT)
    .map(g => describe(g, cfg, window))
    .sort((x, y) => y.kWhPerDay - x.kWhPerDay)
    .map(c => {
      // Two loads of nearly the same size on the same phases would share an id: suffix the second.
      let id = c.id;
      for (let i = 2; used.has(id); i++) id = `${c.id}-${i}`;
      used.add(id);
      return { ...c, id };
    });
}

/**
 * Leader clustering by power and phases; then each group gives up the runs far shorter than its
 * own, which are grouped again among themselves (the kettle that matched the floor heating's size
 * can be a load of its own).
 */
function groupActivations(activations: Activation[], cfg: ClusteringConfig): Group[] {
  const items = activations
    .map(a => ({ a, share: phaseShare(a.delta), logW: Math.log(activationW(a)) }))
    .sort((x, y) => x.logW - y.logW || x.a.start - y.a.start);

  const groups: Group[] = [];
  for (const it of items) {
    let best: Group | null = null;
    let bestD = Infinity;
    for (const g of groups) {
      const dW = Math.abs(it.logW - g.logW);
      const dS = shareDistance(it.share, g.share);
      if (dW <= cfg.MAX_LOG_POWER_DIFF && dS <= cfg.MAX_SHARE_DISTANCE) {
        const d = dW / cfg.MAX_LOG_POWER_DIFF + dS / cfg.MAX_SHARE_DISTANCE;
        if (d < bestD) {
          bestD = d;
          best = g;
        }
      }
    }
    if (!best) {
      groups.push({ share: it.share, logW: it.logW, members: [it.a] });
      continue;
    }
    const n = best.members.length;
    best.members.push(it.a);
    best.logW = (best.logW * n + it.logW) / (n + 1);
    best.share = best.share.map((v, k) => (v * n + it.share[k]) / (n + 1)) as Vec3;
  }

  const evicted: Activation[] = [];
  for (const g of groups) {
    if (g.members.length < cfg.MIN_COUNT) continue;
    const min = quantile(g.members.map(minutesOf).sort((x, y) => x - y), 0.25) / cfg.MIN_DURATION_DIVISOR;
    const short = g.members.filter(a => minutesOf(a) < min);
    if (!short.length) continue;
    evicted.push(...short);
    g.members = g.members.filter(a => minutesOf(a) >= min);
    const shares = g.members.map(a => phaseShare(a.delta));
    g.share = [0, 1, 2].map(k => shares.reduce((s, x) => s + x[k], 0) / shares.length) as Vec3;
    g.logW = g.members.reduce((s, a) => s + Math.log(activationW(a)), 0) / g.members.length;
  }
  // Each pass takes runs from a group that also has longer ones, so the evicted set shrinks.
  return evicted.length ? [...groups, ...groupActivations(evicted, cfg)] : groups;
}

/**
 * Which of a group's runs (in start order) come in bursts: chains of at least BURST_MIN_RUNS runs,
 * each starting within BURST_GAP_MIN of the one before ending. Two close runs are a stop seen late.
 */
function burstFlags(members: Activation[], cfg: ClusteringConfig): boolean[] {
  const gap = cfg.BURST_GAP_MIN * 60_000;
  const flags = members.map(() => false);
  let from = 0;
  for (let i = 1; i <= members.length; i++) {
    if (i < members.length && members[i].start - members[i - 1].end < gap) continue;
    if (i - from >= cfg.BURST_MIN_RUNS) for (let k = from; k < i; k++) flags[k] = true;
    from = i;
  }
  return flags;
}

const regroup = (members: Activation[]): Group => {
  const shares = members.map(a => phaseShare(a.delta));
  return {
    share: [0, 1, 2].map(k => shares.reduce((s, x) => s + x[k], 0) / shares.length) as Vec3,
    logW: members.reduce((s, a) => s + Math.log(activationW(a)), 0) / members.length,
    members,
  };
};

/** A group with both burst runs and lone runs, enough of each: two loads (oven and kettle). */
function splitBursts(g: Group, cfg: ClusteringConfig): Group[] {
  const members = [...g.members].sort((x, y) => x.start - y.start);
  const flags = burstFlags(members, cfg);
  const burst = members.filter((_, i) => flags[i]);
  const lone = members.filter((_, i) => !flags[i]);
  if (burst.length < cfg.MIN_COUNT || lone.length < cfg.MIN_COUNT) return [g];
  // Lone runs far from the group's others (the kettle, once a morning), not a thermostat's
  // cycles that only sometimes come close together: the same load either way.
  const nearest = members
    .map((a, i) => {
      const prev = members[i - 1];
      const next = members[i + 1];
      return Math.min(prev ? a.start - prev.end : Infinity, next ? next.start - a.end : Infinity) / 60_000;
    })
    .filter((_, i) => !flags[i]);
  if (median(nearest) < cfg.LONE_MIN_GAP_MIN) return [g];
  return [regroup(lone), regroup(burst)];
}

function describe(g: Group, cfg: ClusteringConfig, window?: Window): LoadCluster {
  const acts = [...g.members].sort((x, y) => x.start - y.start);
  const watts = acts.map(activationW);
  const minutes = acts.map(minutesOf);
  const sorted = [...minutes].sort((x, y) => x - y);
  const q = (p: number) => quantile(sorted, p);
  const maxMinutes = q(0.75) + 3 * (q(0.75) - q(0.25)) + cfg.DURATION_SLACK_MIN;
  const medianMinutes = median(minutes);
  // A missed stop makes a run far longer than the load runs: count it at the median length.
  const kWh = acts.reduce((s, a) => {
    const m = (a.end - a.start) / 60_000;
    return s + (m > maxMinutes ? (activationW(a) * medianMinutes) / 60_000 : activationKWh(a));
  }, 0);
  const span = window ? window.to - window.from : acts[acts.length - 1].end - acts[0].start;
  const spanDays = Math.max(span / 86_400_000, 1 / 24);
  const gaps = acts.slice(1).map((a, i) => (a.start - acts[i].start) / 60_000);
  const period = gaps.length >= 2 ? median(gaps) : null;
  // Robust spread (scaled median absolute deviation): one missed activation doubles one gap,
  // which would wreck a plain standard deviation but leaves the median alone.
  let cv: number | null = null;
  if (period !== null && period > 0) {
    cv = (1.4826 * median(gaps.map(x => Math.abs(x - period)))) / period;
  }
  const medianW = median(watts);
  const phases = phaseLabel(g.share, cfg.PHASE_SHARE);
  return {
    id: clusterId(phases, medianW),
    phases,
    share: g.share,
    medianW,
    medianMinutes,
    p90Minutes: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))],
    maxMinutes,
    minMinutes: q(0.25) / cfg.MIN_DURATION_DIVISOR,
    count: acts.length,
    startsPerDay: acts.length / spanDays,
    kWhPerDay: kWh / spanDays,
    periodMinutes: period,
    periodCv: cv,
    rhythmic: acts.length >= cfg.RHYTHM_MIN_COUNT && cv !== null && cv < cfg.RHYTHM_MAX_CV,
    bursty: burstFlags(acts, cfg).filter(Boolean).length * 2 > acts.length,
    activations: acts,
  };
}

/**
 * Which known load a new activation belongs to: the nearest load within the clustering limits,
 * or null. Used live (to say "the dishwasher started") and to test on data the loads were not
 * learned from.
 */
export function classify(
  a: Activation,
  loads: LoadCluster[],
  cfg: ClusteringConfig = CLUSTERING,
  /** Still on: how long it will run is not known yet, so no run is too short. */
  running = false,
  /**
   * Minutes since a run of the same size and phases ended (negative: still on), or null when none
   * did lately. Given, it decides between a bursty load and a lone one of the same size.
   */
  context?: { sinceSimilarMin: number | null }
): LoadCluster | null {
  const w = activationW(a);
  if (!(w > 0)) return null;
  const share = phaseShare(a.delta);
  const logW = Math.log(w);
  const minutes = (a.end - a.start) / 60_000;
  let best: LoadCluster | null = null;
  let bestD = Infinity;
  for (const c of loads) {
    const dW = Math.abs(logW - Math.log(c.medianW));
    const dS = shareDistance(share, c.share);
    if (dW > cfg.MAX_LOG_POWER_DIFF || dS > cfg.MAX_SHARE_DISTANCE) continue;
    // A start paired with the wrong, much later stop: far longer than the load ever runs.
    if (minutes > cfg.MAX_DURATION_FACTOR * c.p90Minutes + cfg.DURATION_SLACK_MIN) continue;
    // Far shorter than the load runs: another appliance of the same size.
    if (!running && minutes < (c.minMinutes ?? 0)) continue;
    let d = dW / cfg.MAX_LOG_POWER_DIFF + dS / cfg.MAX_SHARE_DISTANCE;
    if (context) {
      const recent = context.sinceSimilarMin !== null && context.sinceSimilarMin < cfg.BURST_GAP_MIN;
      const wrong = c.bursty
        ? !recent && minutes <= cfg.BURST_LONG_MIN
        : recent || minutes > Math.max(cfg.BURST_LONG_MIN, 1.5 * c.p90Minutes);
      if (wrong) d += 2; // the other load of this size fits better; still this one if it is the only one
    }
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * Minutes from the end of the latest run like `a` (same limits as classify) to a's start; null if
 * none ended within an hour before. Looks at the last 300 runs. For classify's context.
 */
export function minutesSinceSimilar(a: { start: number; delta: Vec3 }, acts: Activation[], cfg: ClusteringConfig = CLUSTERING): number | null {
  const w = activationW({ start: a.start, end: a.start, delta: a.delta });
  if (!(w > 0)) return null;
  const share = phaseShare(a.delta);
  const logW = Math.log(w);
  let best: number | null = null;
  for (let i = acts.length - 1; i >= Math.max(0, acts.length - 300); i--) {
    const b = acts[i];
    if (b.start >= a.start || a.start - b.end > 3_600_000) continue;
    const bw = activationW(b);
    if (!(bw > 0) || Math.abs(Math.log(bw) - logW) > cfg.MAX_LOG_POWER_DIFF || shareDistance(phaseShare(b.delta), share) > cfg.MAX_SHARE_DISTANCE) continue;
    const m = (a.start - b.end) / 60_000;
    if (best === null || m < best) best = m;
  }
  return best;
}
