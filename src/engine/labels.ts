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
  /**
   * A load is tied to a device only if its matches would be this unlikely by chance: the
   * binomial tail of its hits among its runs, at the chance rate measured by shifting the
   * device's runs out of phase (see `chancePrecision`). A device on all day matches every load
   * by chance, so it names none.
   */
  alpha?: number;
  /**
   * Programme parts: every load that falls inside the device's runs (precision and lift) is a
   * part of it, however rarely it occurs; recall and F1 do not decide. A modulating heat pump's
   * boost in one run of four is still the heat pump.
   */
  parts?: boolean;
}

/** P(X >= k) for X ~ Binomial(n, p). */
export function binomialTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let term = Math.pow(1 - p, n); // P(X = 0)
  let below = 0;
  for (let i = 0; i < k; i++) {
    below += term;
    term *= ((n - i) / (i + 1)) * (p / (1 - p));
  }
  return Math.max(0, Math.min(1, 1 - below));
}

/** Phase shifts, as fractions of the device's own cycle: far from 0 and 1, so none can line up for real. */
export const CHANCE_PHASES = [0.25, 0.33, 0.42, 0.5, 0.58, 0.67, 0.75];

/**
 * The precision a load would get by chance: its mean precision against the device's runs
 * shifted by fractions of the device's typical start-to-start time (a random-phase null). A
 * device that is on all the time or cycles faster than the load still "matches" when shifted;
 * a real match does not survive the shift.
 */
export function chancePrecision(refRuns: Interval[], ownRuns: Interval[], tolMs: number, ratio: number): number {
  const starts = refRuns.map(r => r.start).sort((a, b) => a - b);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]).sort((a, b) => a - b);
  const cycle = gaps.length ? gaps[gaps.length >> 1] : 86_400_000;
  const p = CHANCE_PHASES.map(f => {
    const dt = f * cycle;
    const shifted = refRuns.map(r => ({ start: r.start + dt, end: r.end + dt }));
    return matchIntervals(shifted, ownRuns, tolMs, ratio).precision;
  });
  return p.reduce((a, b) => a + b, 0) / p.length;
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
    const beatsChance = (c: LoadCluster, s: Score) => {
      if (opts.alpha === undefined) return true;
      const own = runs.get(c.id) ?? [];
      return binomialTail(s.tp, own.length, chancePrecision(refRuns, own, opts.tolMs, ratio)) <= opts.alpha;
    };
    const ranked = clusters
      .map(c => ({ c, s: matchIntervals(refRuns, runs.get(c.id) ?? [], opts.tolMs, ratio) }))
      .filter(x => x.s.tp >= 2 && x.s.precision >= minPrecision && beatsChance(x.c, x.s))
      .sort((a, b) => b.s.tp - a.s.tp || b.s.precision - a.s.precision);

    if (opts.parts) {
      if (ranked.length === 0) continue;
      const all = ranked.map(x => x.c);
      const score = matchIntervals(refRuns, sessions(all.flatMap(x => asIntervals(x.activations)), gapMs), opts.tolMs, ratio);
      candidates.push({ referenceId: ref.id, referenceName: ref.name, clusterIds: all.map(c => c.id), score });
      continue;
    }
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
    if (opts.parts || score.f1 >= minF1) out.push({ ...m, clusterIds: free, score });
  }
  return out;
}
