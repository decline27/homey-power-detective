/**
 * The load-detection engine: readings in, loads out. Pure (no Homey), so the same code runs in
 * the app, in the tests and in the benchmarks.
 *
 *   reading (per-phase W, total W)
 *     -> StepDetector  (switch-on / switch-off steps per phase)
 *     -> Pairer        (start + stop of the same load = one activation)
 *     -> store         (21 days, capped)
 *     -> analyse()     (loads with statistics, whole-house days)
 */
import { clusterActivations } from './clustering';
import { DETECTOR, PAIRING, STORE } from './config';
import { DayMeter, DayRecord } from './day-meter';
import { decompose } from './decompose';
import { StepDetector } from './detector';
import { Pairer } from './pairer';
import { Activation, LoadCluster, Sample, StepEvent, Vec3 } from './types';

export interface Reading extends Sample {
  /** Whole-house active power (W). Falls back to the sum of the phases. */
  total?: number;
}

export interface EngineSnapshot {
  version: 1;
  activations: Array<[number, number, number, number, number]>;
  open: Array<[number, number, number, number, number]>;
  days: DayRecord[];
  firstReading: number | null;
  lastReading: number | null;
}

export interface PushResult {
  steps: StepEvent[];
  activations: Activation[];
}

export class PowerEngine {
  private detector = new StepDetector(DETECTOR);
  private pairer = new Pairer(PAIRING);
  private activations: Activation[] = [];
  private meter: DayMeter;
  private firstReading: number | null = null;
  private lastReading: number | null = null;

  constructor(readonly timeZone = 'Europe/Stockholm') {
    this.meter = new DayMeter(timeZone);
  }

  push(r: Reading): PushResult {
    const total = Number.isFinite(r.total) ? (r.total as number) : r.w[0] + r.w[1] + r.w[2];
    this.meter.push(r.t, total);
    if (this.firstReading === null) this.firstReading = r.t;
    this.lastReading = r.t;
    const steps: StepEvent[] = [];
    const activations: Activation[] = [];
    for (const change of this.detector.push({ t: r.t, w: r.w, total })) {
      for (const step of decompose(change, this.pairer.running(), DETECTOR)) {
        steps.push(step);
        const a = this.pairer.push(step);
        if (a) activations.push(a);
      }
    }
    if (activations.length) {
      this.activations.push(...activations);
      this.prune(r.t);
    }
    return { steps, activations };
  }

  private prune(now: number): void {
    const cutoff = now - STORE.RETENTION_DAYS * 86_400_000;
    if (this.activations.length && this.activations[0].start < cutoff) {
      this.activations = this.activations.filter(a => a.start >= cutoff);
    }
    if (this.activations.length > STORE.MAX_ACTIVATIONS) {
      this.activations = this.activations.slice(-STORE.MAX_ACTIVATIONS);
    }
  }

  /** Loads seen in the window (default: everything stored). */
  loads(from?: number, to?: number): LoadCluster[] {
    const lo = from ?? this.firstReading ?? 0;
    const hi = to ?? this.lastReading ?? Date.now();
    const acts = this.activations.filter(a => a.start >= lo && a.start < hi);
    return clusterActivations(acts, { from: Math.max(lo, this.firstReading ?? lo), to: hi });
  }

  /** Starts with no stop yet: loads running now. */
  running(): StepEvent[] {
    return this.pairer.running();
  }

  allActivations(): Activation[] {
    return [...this.activations];
  }

  days(): DayRecord[] {
    return this.meter.all();
  }

  observedFrom(): number | null {
    return this.firstReading;
  }

  snapshot(): EngineSnapshot {
    const pack = (a: { delta: Vec3 }, x: number, y: number): [number, number, number, number, number] => [
      x, y, Math.round(a.delta[0]), Math.round(a.delta[1]), Math.round(a.delta[2]),
    ];
    return {
      version: 1,
      activations: this.activations.map(a => pack(a, a.start, a.end)),
      open: this.pairer.running().map(s => pack(s, s.t, s.settledAt)),
      days: this.meter.all(),
      firstReading: this.firstReading,
      lastReading: this.lastReading,
    };
  }

  static restore(snap: unknown, timeZone = 'Europe/Stockholm'): PowerEngine {
    const e = new PowerEngine(timeZone);
    if (!snap || typeof snap !== 'object' || (snap as EngineSnapshot).version !== 1) return e;
    const s = snap as EngineSnapshot;
    const ok = (row: unknown): row is [number, number, number, number, number] =>
      Array.isArray(row) && row.length === 5 && row.every(x => typeof x === 'number' && Number.isFinite(x));
    e.activations = (Array.isArray(s.activations) ? s.activations : [])
      .filter(ok)
      .map(([start, end, a, b, c]) => ({ start, end, delta: [a, b, c] as Vec3 }))
      .sort((x, y) => x.start - y.start)
      .slice(-STORE.MAX_ACTIVATIONS);
    e.pairer.restore(
      (Array.isArray(s.open) ? s.open : []).filter(ok).map(([t, settledAt, a, b, c]) => ({ t, settledAt, delta: [a, b, c] as Vec3 }))
    );
    e.meter.restore(Array.isArray(s.days) ? s.days : []);
    e.firstReading = typeof s.firstReading === 'number' ? s.firstReading : null;
    e.lastReading = typeof s.lastReading === 'number' ? s.lastReading : null;
    return e;
  }
}
