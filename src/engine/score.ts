/**
 * The judge: compares what the engine found with an independent reference (a device's own power
 * meter, MELCloud's compressor frequency, hand-annotated appliance runs) and scores it. Used by
 * the tests, the benchmarks and, live, to show how well each named load is recognised.
 */
import { Activation } from './types';

export interface Interval {
  start: number;
  end: number;
}

export interface Score {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export function makeScore(tp: number, fp: number, fn: number): Score {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, precision, recall, f1 };
}

/** Merges intervals closer than `gapMs` into one run (an appliance cycle made of several steps). */
export function sessions(items: Interval[], gapMs: number): Interval[] {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && it.start - last.end <= gapMs) last.end = Math.max(last.end, it.end);
    else out.push({ start: it.start, end: it.end });
  }
  return out;
}

const overlap = (a: Interval, b: Interval) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/**
 * One-to-one matching of detected runs to reference runs. A pair matches when they overlap once
 * the reference is widened by `tolMs` on both sides (the reference may lag, like MELCloud, or be
 * annotated by hand). Larger overlaps are matched first.
 */
export function matchIntervals(
  reference: Interval[],
  detected: Interval[],
  tolMs: number,
  maxDurationRatio = 3
): Score {
  // Lengths below the timing tolerance are not resolvable, so they count as the tolerance.
  const len = (x: Interval) => Math.max(x.end - x.start, tolMs, 1);
  const pairs: Array<{ r: number; d: number; o: number }> = [];
  reference.forEach((r, ri) => {
    const wide = { start: r.start - tolMs, end: r.end + tolMs };
    detected.forEach((d, di) => {
      const o = overlap(wide, d);
      const touches = o > 0 || (d.start === d.end && d.start >= wide.start && d.start <= wide.end);
      // A 20-minute heater cycle is not a 4-minute compressor run just because they overlap.
      const ratio = Math.max(len(r), len(d)) / Math.min(len(r), len(d));
      if (touches && ratio <= maxDurationRatio) pairs.push({ r: ri, d: di, o });
    });
  });
  pairs.sort((a, b) => b.o - a.o);
  const usedR = new Set<number>();
  const usedD = new Set<number>();
  for (const p of pairs) {
    if (usedR.has(p.r) || usedD.has(p.d)) continue;
    usedR.add(p.r);
    usedD.add(p.d);
  }
  const tp = usedR.size;
  return makeScore(tp, detected.length - tp, reference.length - tp);
}

/** On-intervals of a device from its power readings: on while above `thresholdW`. */
export function intervalsFromPower(
  readings: Array<{ t: number; v: number | null }>,
  thresholdW: number,
  maxGapMs: number
): Interval[] {
  const out: Interval[] = [];
  let open: Interval | null = null;
  let lastT: number | null = null;
  for (const { t, v } of [...readings].sort((a, b) => a.t - b.t)) {
    if (open && lastT !== null && t - lastT > maxGapMs) {
      open.end = lastT;
      out.push(open);
      open = null;
    }
    const on = typeof v === 'number' && Number.isFinite(v) && v > thresholdW;
    if (on && !open) open = { start: t, end: t };
    else if (!on && open) {
      open.end = t;
      out.push(open);
      open = null;
    }
    lastT = t;
  }
  if (open && lastT !== null) {
    open.end = lastT;
    out.push(open);
  }
  return out;
}

export const asIntervals = (acts: Activation[]): Interval[] => acts.map(a => ({ start: a.start, end: a.end }));

/** Energy in the reference intervals that the detected activations account for (kWh both). */
export function energyRatio(detectedKWh: number, referenceKWh: number): number | null {
  return referenceKWh > 0 ? detectedKWh / referenceKWh : null;
}
