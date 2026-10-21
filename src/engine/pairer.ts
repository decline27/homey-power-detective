/**
 * Pairs each stop with the start of the same load, giving activations (on from..to, at W).
 *
 * A stop matches an open start when both hit the same phases in the same proportions (cosine
 * of the per-phase steps) and are of similar size. Of the candidates, the best match wins and,
 * at equal quality, the most recent one (loads that start last tend to be the short ones that
 * stop first).
 */
import { PAIRING } from './config';
import { Activation, StepEvent, Vec3 } from './types';

export type PairingConfig = typeof PAIRING;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3) => Math.sqrt(dot(a, a));
const sum3 = (v: Vec3) => v[0] + v[1] + v[2];

export function cosine(a: Vec3, b: Vec3): number {
  const n = norm(a) * norm(b);
  return n === 0 ? 0 : dot(a, b) / n;
}

/** How well a stop step matches a start step: 0 (no match) to 1 (identical). */
export function matchScore(on: Vec3, off: Vec3, cfg: PairingConfig = PAIRING): number {
  const neg: Vec3 = [-off[0], -off[1], -off[2]];
  const cos = cosine(on, neg);
  if (cos < cfg.MIN_COSINE) return 0;
  const ratio = sum3(neg) / sum3(on);
  if (!(ratio >= cfg.MIN_RATIO && ratio <= cfg.MAX_RATIO)) return 0;
  return cos * (1 - Math.abs(Math.log(ratio)) / Math.log(cfg.MAX_RATIO) * 0.5);
}

export class Pairer {
  private open: StepEvent[] = [];

  constructor(private readonly cfg: PairingConfig = PAIRING) {}

  /** Feeds one step; returns the activation it closed, if any. */
  push(step: StepEvent): Activation | null {
    this.open = this.open.filter(o => step.t - o.t <= this.cfg.MAX_ON_MS);
    if (sum3(step.delta) > 0) {
      this.open.push(step);
      if (this.open.length > this.cfg.MAX_OPEN) this.open.shift();
      return null;
    }
    // Of the starts that match about as well as the best one, take the most recent: a fridge that
    // started 2 minutes ago stops before a same-size load that started 15 minutes ago.
    const scores = this.open.map(o => matchScore(o.delta, step.delta, this.cfg));
    const top = Math.max(0, ...scores);
    if (top <= 0) return null;
    let best = -1;
    for (let i = 0; i < this.open.length; i++) {
      if (scores[i] >= top * this.cfg.NEAR_BEST && (best < 0 || this.open[i].t > this.open[best].t)) best = i;
    }
    const on = this.open.splice(best, 1)[0];
    // Similar steps: average them. Different sizes mean another load switched in the same
    // reading as one of them; the start (sized after the load settled) is then the better one.
    const ratio = -sum3(step.delta) / sum3(on.delta);
    const delta = (ratio >= 0.7 && ratio <= 1.4
      ? on.delta.map((v, k) => (v - step.delta[k]) / 2)
      : [...on.delta]) as Vec3;
    return { start: on.t, end: step.t, delta };
  }

  /** Starts still waiting for their stop (loads running now). */
  running(): StepEvent[] {
    return [...this.open];
  }

  restore(open: StepEvent[]): void {
    this.open = open.slice(-this.cfg.MAX_OPEN);
  }
}
