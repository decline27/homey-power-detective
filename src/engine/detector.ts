/**
 * Finds the moments loads switch on or off, from per-phase power plus the house total.
 *
 * Steady-state segmentation (G. W. Hart, "Nonintrusive appliance load monitoring", Proc. IEEE
 * 1992), run on each phase on its own: a phase sits at a steady level until a reading leaves its
 * noise band; the readings that follow are a transition until SETTLE_SAMPLES in a row agree on a
 * new level. Each phase is followed separately because loads on other phases are independent:
 * a coffee machine pulsing on L2 every three minutes must not hide a dishwasher heater on L3.
 *
 * Steps on several phases that start together (within COMBINE_MS) are one change: that is how a
 * 3-phase heat pump or a 400 V heater shows itself, and what a single total-power reading cannot
 * see. The change is sized by the house total (active power) when the total moved by a plausible
 * amount, because per-phase values from current × voltage include reactive current and rounding.
 * Turning a change into the starts and stops of loads is decompose.ts's job.
 */
import { DETECTOR } from './config';
import { Sample, Vec3 } from './types';

export type DetectorConfig = typeof DETECTOR;

/** A move from one steady level to another: per phase (shape) and in the total (size). */
export interface LevelChange {
  t: number;
  settledAt: number;
  phase: Vec3;
  total: number;
}

export interface DetectorInput extends Sample {
  /** Whole-house active power (W); the sum of the phases when absent. */
  total?: number;
}

interface PhaseStep {
  phase: number;
  t: number;
  settledAt: number;
  delta: number;
}

/** Steady-state segmentation of one signal. */
class PhaseTracker {
  level: number | null = null;
  private count = 0;
  private before: number | null = null;
  private transition: Array<{ t: number; v: number }> = [];

  constructor(private readonly cfg: DetectorConfig) {}

  private tol(level: number): number {
    return Math.max(this.cfg.TOL_ABS_W, this.cfg.TOL_REL * Math.abs(level));
  }

  inTransition(): boolean {
    return this.before !== null;
  }

  reset(): void {
    this.level = null;
    this.count = 0;
    this.before = null;
    this.transition = [];
  }

  push(t: number, v: number): { t: number; settledAt: number; delta: number } | null {
    if (this.level === null) {
      this.level = v;
      this.count = 1;
      return null;
    }
    if (this.before === null) {
      if (Math.abs(v - this.level) <= this.tol(this.level)) {
        const n = Math.min(this.count, 29) + 1;
        this.level += (v - this.level) / n;
        this.count = n;
        return null;
      }
      this.before = this.level;
      this.transition = [{ t, v }];
      return null;
    }
    this.transition.push({ t, v });
    const n = this.cfg.SETTLE_SAMPLES;
    const tail = this.transition.slice(-n);
    const lo = Math.min(...tail.map(x => x.v));
    const hi = Math.max(...tail.map(x => x.v));
    // Tighter than the steady band: a ramp moving less than the noise band per reading would
    // otherwise look settled halfway up.
    const settled = tail.length >= n && hi - lo <= this.cfg.SETTLE_BAND * this.tol((hi + lo) / 2);
    if (!settled && this.transition.length < this.cfg.MAX_TRANSITION_SAMPLES) return null;
    const after = tail.reduce((s, x) => s + x.v, 0) / tail.length;
    const out = { t: this.transition[0].t, settledAt: tail[0].t, delta: after - this.before };
    this.level = after;
    this.count = tail.length;
    this.before = null;
    this.transition = [];
    return out;
  }
}

export class StepDetector {
  private phases: PhaseTracker[];
  private lastT: number | null = null;
  private pending: PhaseStep[] = [];
  /** Recent total readings, to size changes. */
  private totals: Array<{ t: number; v: number }> = [];
  /** Typical time between readings (ms): the windows scale with it (10 s meters, 1 min logs). */
  private interval = 10_000;

  constructor(private readonly cfg: DetectorConfig = DETECTOR) {
    this.phases = [0, 1, 2].map(() => new PhaseTracker(cfg));
  }

  private reset(): void {
    this.phases.forEach(p => p.reset());
    this.lastT = null;
    this.pending = [];
    this.totals = [];
  }

  /** Feeds one reading; returns the level changes it completed. */
  push(sample: DetectorInput): LevelChange[] {
    const total = Number.isFinite(sample.total) ? (sample.total as number) : sample.w[0] + sample.w[1] + sample.w[2];
    const values = [sample.w[0], sample.w[1], sample.w[2], total];
    if (!Number.isFinite(sample.t) || !values.every(Number.isFinite)) {
      this.reset();
      return [];
    }
    if (this.lastT !== null) {
      if (sample.t <= this.lastT) return [];
      // A gap: what happened in between is unknown, so start over.
      const dt = sample.t - this.lastT;
      if (dt > this.cfg.MAX_GAP_MS) this.reset();
      else this.interval += (dt - this.interval) * 0.1;
    }
    this.lastT = sample.t;
    this.totals.push({ t: sample.t, v: total });
    if (this.totals.length > 64) this.totals.shift();

    for (let k = 0; k < 3; k++) {
      const s = this.phases[k].push(sample.t, sample.w[k]);
      if (s && Math.abs(s.delta) >= this.cfg.PHASE_MIN_STEP_W) this.pending.push({ phase: k, ...s });
    }
    return this.flush(sample.t);
  }

  /** Closes groups of phase steps once no phase that could still join them is moving. */
  private flush(now: number): LevelChange[] {
    const out: LevelChange[] = [];
    const busy = this.phases.some(p => p.inTransition());
    // Phases of one load reach the meter in the same reading; with averaged data (one value a
    // minute) they can land a reading apart.
    const window = Math.max(this.cfg.COMBINE_MS, 1.5 * this.interval);
    const maxWait = Math.max(this.cfg.COMBINE_MAX_WAIT_MS, this.cfg.MAX_TRANSITION_SAMPLES * this.interval);
    while (this.pending.length) {
      this.pending.sort((a, b) => a.t - b.t);
      const first = this.pending[0].t;
      if (now - first < window || (busy && now - first < maxWait)) break;
      const group = this.pending.filter(s => s.t - first <= window);
      this.pending = this.pending.filter(s => s.t - first > window);
      const phase: Vec3 = [0, 0, 0];
      for (const s of group) phase[s.phase] += s.delta;
      const settledAt = Math.max(...group.map(s => s.settledAt));
      const sum = phase[0] + phase[1] + phase[2];
      const measured = this.totalChange(first, settledAt);
      // Use the total when it moved like the phases did (same direction, plausible size);
      // otherwise something else moved the total in the same moment.
      const ratio = measured !== null && sum !== 0 ? measured / sum : NaN;
      const sized = Number.isFinite(ratio) && ratio > 0.5 && ratio < 2.5 ? (measured as number) : sum;
      const big = Math.abs(sized) >= this.cfg.MIN_STEP_W || phase.some(v => Math.abs(v) >= this.cfg.MIN_STEP_W);
      if (big) out.push({ t: first, settledAt, phase, total: sized });
    }
    return out;
  }

  /** Total after the change minus total before it, from the recent readings. */
  private totalChange(start: number, settledAt: number): number | null {
    const before = [...this.totals].reverse().find(x => x.t < start);
    const after = this.totals.filter(x => x.t >= settledAt);
    if (!before || after.length === 0) return null;
    return after.reduce((s, x) => s + x.v, 0) / after.length - before.v;
  }
}
