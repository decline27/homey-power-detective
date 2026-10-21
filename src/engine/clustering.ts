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

export function clusterActivations(
  activations: Activation[],
  window?: Window,
  cfg: ClusteringConfig = CLUSTERING
): LoadCluster[] {
  const items = activations
    .filter(a => activationW(a) > 0 && a.end > a.start)
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

  const used = new Set<string>();
  return groups
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

function describe(g: Group, cfg: ClusteringConfig, window?: Window): LoadCluster {
  const acts = [...g.members].sort((x, y) => x.start - y.start);
  const watts = acts.map(activationW);
  const minutes = acts.map(a => (a.end - a.start) / 60_000);
  const sorted = [...minutes].sort((x, y) => x - y);
  const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))];
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
    count: acts.length,
    startsPerDay: acts.length / spanDays,
    kWhPerDay: kWh / spanDays,
    periodMinutes: period,
    periodCv: cv,
    rhythmic: acts.length >= cfg.RHYTHM_MIN_COUNT && cv !== null && cv < cfg.RHYTHM_MAX_CV,
    activations: acts,
  };
}

/**
 * Which known load a new activation belongs to: the nearest load within the clustering limits,
 * or null. Used live (to say "the dishwasher started") and to test on data the loads were not
 * learned from.
 */
export function classify(a: Activation, loads: LoadCluster[], cfg: ClusteringConfig = CLUSTERING): LoadCluster | null {
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
    const d = dW / cfg.MAX_LOG_POWER_DIFF + dS / cfg.MAX_SHARE_DISTANCE;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}
