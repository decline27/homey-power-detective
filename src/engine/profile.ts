/**
 * What a run of a named appliance looks like, learned from runs a reference confirmed (a plug
 * meter, MELCloud, an annotation, the user's own switch-off test): how many activations of its
 * loads a run has, how long the run lasts and how much energy it takes. A dishwasher heats twice,
 * 45 minutes apart, for about 8 minutes each; an oven element of the same size and phase does
 * not. Runs outside the learned range are not attributed to the appliance.
 */
import { median } from './clustering';
import { Interval } from './score';
import { Activation, activationKWh } from './types';

export interface RunFeatures {
  count: number;
  spanMinutes: number;
  kWh: number;
}

export interface Profile {
  count: [number, number];
  spanMinutes: [number, number];
  kWh: [number, number];
  /** Runs it was learned from. */
  learnedFrom: number;
}

/** Groups activations into runs (closer than gapMs) with their features. */
export function runsOf(acts: Activation[], gapMs: number): Array<Interval & RunFeatures & { acts: Activation[] }> {
  const sorted = [...acts].sort((a, b) => a.start - b.start);
  const out: Array<Interval & RunFeatures & { acts: Activation[] }> = [];
  for (const a of sorted) {
    const last = out[out.length - 1];
    if (last && a.start - last.end <= gapMs) {
      last.acts.push(a);
      last.end = Math.max(last.end, a.end);
    } else {
      out.push({ start: a.start, end: a.end, acts: [a], count: 0, spanMinutes: 0, kWh: 0 });
    }
  }
  for (const r of out) {
    r.count = r.acts.length;
    r.spanMinutes = (r.end - r.start) / 60_000;
    r.kWh = r.acts.reduce((s, a) => s + activationKWh(a), 0);
  }
  return out;
}

function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Learns the range of the confirmed runs: 5th to 95th percentile, widened by `margin` on both
 * sides. Null with fewer than `minRuns` confirmed runs: too few to say what a run looks like.
 */
export function learnProfile(confirmed: RunFeatures[], margin = 0.25, minRuns = 5): Profile | null {
  if (confirmed.length < minRuns) return null;
  const range = (xs: number[]): [number, number] => {
    const lo = quantile(xs, 0.05);
    const hi = quantile(xs, 0.95);
    const pad = Math.max((hi - lo) * margin, median(xs) * margin);
    return [Math.max(0, lo - pad), hi + pad];
  };
  return {
    count: range(confirmed.map(r => r.count)),
    spanMinutes: range(confirmed.map(r => r.spanMinutes)),
    kWh: range(confirmed.map(r => r.kWh)),
    learnedFrom: confirmed.length,
  };
}

export function fits(p: Profile, r: RunFeatures): boolean {
  const inside = (x: number, [lo, hi]: [number, number]) => x >= lo && x <= hi;
  return inside(r.count, p.count) && inside(r.spanMinutes, p.spanMinutes) && inside(r.kWh, p.kWh);
}

/** Lower bounds a run must reach to count as the appliance. */
export interface RunFilter {
  minCount: number;
  minSpanMinutes: number;
  minKWh: number;
  /** F1 on the runs it was learned from. */
  trainF1: number;
}

/**
 * Learns the lower bounds that best separate confirmed runs from other runs of the same loads
 * (a kettle on the same phase as a washing machine's heater makes short, one-step runs). Exhaustive
 * search over the observed values; ties go to the least restrictive filter.
 */
export function learnRunFilter(runs: RunFeatures[], confirmed: boolean[]): RunFilter | null {
  const positives = confirmed.filter(Boolean).length;
  if (runs.length !== confirmed.length || positives < 5) return null;
  const candidates = (pick: (r: RunFeatures) => number) => {
    const vals = Array.from(new Set(runs.filter((_, i) => confirmed[i]).map(pick))).sort((a, b) => a - b);
    // Thresholds at confirmed values up to the median of the confirmed runs (never stricter).
    return [0, ...vals.slice(0, Math.ceil(vals.length / 2))];
  };
  const counts = candidates(r => r.count);
  const spans = candidates(r => r.spanMinutes);
  const energies = candidates(r => r.kWh);
  let best: RunFilter = { minCount: 0, minSpanMinutes: 0, minKWh: 0, trainF1: -1 };
  for (const c of counts) {
    for (const s of spans) {
      for (const e of energies) {
        let tp = 0;
        let fp = 0;
        runs.forEach((r, i) => {
          if (r.count >= c && r.spanMinutes >= s && r.kWh >= e) confirmed[i] ? tp++ : fp++;
        });
        const fn = positives - tp;
        const f1 = tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
        if (f1 > best.trainF1 + 1e-9) best = { minCount: c, minSpanMinutes: s, minKWh: e, trainF1: f1 };
      }
    }
  }
  return best;
}

export function passes(f: RunFilter, r: RunFeatures): boolean {
  return r.count >= f.minCount && r.spanMinutes >= f.minSpanMinutes && r.kWh >= f.minKWh;
}
