/**
 * Names loads from devices that measure themselves. Homey already knows when the EV charger,
 * the heat pump (through MELCloud) or a smart plug draws power; a load whose runs coincide with
 * one of those is that device. The same match is the live judge: it scores how well the engine,
 * seeing only the house meter, finds each metered device.
 */
import { SESSIONS } from './config';
import { Interval, Score, asIntervals, matchIntervals, sessions } from './score';
import { LoadCluster } from './types';

export interface Reference {
  id: string;
  name: string;
  intervals: Interval[];
}

export interface LabelMatch {
  referenceId: string;
  referenceName: string;
  clusterIds: string[];
  score: Score;
}

export interface MatchOptions {
  /** Reference timing error allowed (ms): MELCloud reports a run 1-5 minutes late. */
  tolMs: number;
  /** Runs of one appliance closer than this are one run (ms). */
  gapMs?: number;
  /** A load is only tied to a device if this share of its runs falls inside the device's runs. */
  minPrecision?: number;
  /** The best combination must reach this F1 to name the device. */
  minF1?: number;
  /**
   * Longest/shortest run length allowed for a match. 3 for devices whose runs are the load's own
   * runs (a compressor); Infinity when the reference is a whole programme and the load one part
   * of it (a dishwasher's heater inside a 90-minute wash).
   */
  maxDurationRatio?: number;
}

export function matchReferences(clusters: LoadCluster[], refs: Reference[], opts: MatchOptions): LabelMatch[] {
  const gapMs = opts.gapMs ?? SESSIONS.GAP_MS;
  const minPrecision = opts.minPrecision ?? 0.7;
  const minF1 = opts.minF1 ?? 0.5;
  const ratio = opts.maxDurationRatio ?? 3;
  const runs = new Map(clusters.map(c => [c.id, sessions(asIntervals(c.activations), gapMs)]));

  const candidates: Array<LabelMatch> = [];
  for (const ref of refs) {
    const refRuns = sessions(ref.intervals, gapMs);
    if (refRuns.length === 0) continue;
    const ranked = clusters
      .map(c => ({ c, s: matchIntervals(refRuns, runs.get(c.id) ?? [], opts.tolMs, ratio) }))
      .filter(x => x.s.tp >= 2 && x.s.precision >= minPrecision)
      .sort((a, b) => b.s.tp - a.s.tp || b.s.precision - a.s.precision);

    // Greedily add loads while the combined score improves (an appliance can show as several loads,
    // e.g. a dishwasher's heater and its pump).
    let chosen: LoadCluster[] = [];
    let best: Score | null = null;
    for (const { c } of ranked) {
      const trial = [...chosen, c];
      const s = matchIntervals(refRuns, sessions(trial.flatMap(x => asIntervals(x.activations)), gapMs), opts.tolMs, ratio);
      if (!best || s.f1 > best.f1) {
        chosen = trial;
        best = s;
      }
    }
    if (best && best.f1 >= minF1) {
      candidates.push({ referenceId: ref.id, referenceName: ref.name, clusterIds: chosen.map(c => c.id), score: best });
    }
  }

  // A load belongs to one device: the one it matches best.
  candidates.sort((a, b) => b.score.f1 - a.score.f1);
  const taken = new Set<string>();
  const out: LabelMatch[] = [];
  for (const m of candidates) {
    const free = m.clusterIds.filter(id => !taken.has(id));
    if (free.length === 0) continue;
    free.forEach(id => taken.add(id));
    if (free.length === m.clusterIds.length) {
      out.push(m);
      continue;
    }
    const ref = refs.find(r => r.id === m.referenceId)!;
    const own = clusters.filter(c => free.includes(c.id));
    const score = matchIntervals(sessions(ref.intervals, gapMs), sessions(own.flatMap(c => asIntervals(c.activations)), gapMs), opts.tolMs, ratio);
    if (score.f1 >= minF1) out.push({ ...m, clusterIds: free, score });
  }
  return out;
}
