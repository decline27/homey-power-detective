/** Per-phase values, L1..L3. */
export type Vec3 = [number, number, number];

/** One meter reading: time (ms) and power per phase (W). */
export interface Sample {
  t: number;
  w: Vec3;
}

/** A change from one steady level to another, found in the per-phase power. */
export interface StepEvent {
  /** Time the change began (ms). */
  t: number;
  /** Time the new level was reached (ms). */
  settledAt: number;
  /** New level minus old level, per phase (W), sized by the house total. Positive: switched on. */
  delta: Vec3;
  /** The same step as the phases measured it (current × voltage), before sizing. */
  raw?: Vec3;
}

/** A load that switched on and later off: one start event paired with one stop event. */
export interface Activation {
  start: number;
  end: number;
  /** Power the load drew, per phase (W): the mean of its start and stop steps. */
  delta: Vec3;
}

/** A group of activations that look like the same load. */
export interface LoadCluster {
  id: string;
  /** Which phases carry the load, e.g. "L1", "L2+L3", "3-phase". */
  phases: string;
  /** Share of the load on each phase (sums to 1). */
  share: Vec3;
  /** Typical power while on (W). */
  medianW: number;
  medianMinutes: number;
  /** 90th percentile of the run length (minutes): how long the load's long runs last. */
  p90Minutes: number;
  /**
   * Longest plausible run (minutes): Q3 + 3 IQR + 10 min of the run lengths (Tukey's far-out
   * fence). A longer run is a missed stop; its energy counts at the median length.
   */
  maxMinutes: number;
  /** Shortest run that can be this load (minutes): its short runs (25th pct) / MIN_DURATION_DIVISOR. */
  minMinutes: number;
  count: number;
  /** Activations per day over the observed span. */
  startsPerDay: number;
  kWhPerDay: number;
  /** Median time between starts (minutes), null with fewer than 3 activations. */
  periodMinutes: number | null;
  /** Coefficient of variation of the time between starts, null with fewer than 3. */
  periodCv: number | null;
  /** Switches on and off on a steady rhythm: a thermostat or a timer drives it. */
  rhythmic: boolean;
  activations: Activation[];
}

export const activationW = (a: Activation): number => a.delta[0] + a.delta[1] + a.delta[2];
export const activationKWh = (a: Activation): number => (activationW(a) * (a.end - a.start)) / 3.6e9;
