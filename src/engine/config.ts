/**
 * Detection settings. They are physical limits of the measurement and of household loads, not
 * per-house tuning: a Swedish HAN meter reports every 10 s with 0.1 A current resolution
 * (about 23 W per phase at 230 V), and the loads that matter for the bill draw hundreds of watts.
 */
export const DETECTOR = {
  /** Per-phase noise band of a steady level (W): absolute floor... */
  TOL_ABS_W: 60,
  /** ...or this share of the level, whichever is larger. */
  TOL_REL: 0.04,
  /** Readings in a row that must agree before a new level counts as reached. */
  SETTLE_SAMPLES: 2,
  /** A change still moving after this many readings is closed at its latest level. */
  MAX_TRANSITION_SAMPLES: 12,
  /** Smallest change reported, summed over the phases (W). */
  MIN_STEP_W: 250,
  /** Smallest change on one phase that can be part of a change (a 3-phase load splits its power). */
  PHASE_MIN_STEP_W: 100,
  /** Phase steps starting within this window are one change (ms). */
  COMBINE_MS: 25_000,
  /** A change is reported at most this long after it started, even if a phase is still moving (ms). */
  COMBINE_MAX_WAIT_MS: 180_000,
  /** Longest gap between readings that keeps the level known (ms). */
  MAX_GAP_MS: 90_000,
};

export const PAIRING = {
  /** Start and stop must hit the same phases: cosine of their per-phase steps. */
  MIN_COSINE: 0.85,
  /**
   * Stop size over start size. Wide, because inverter loads drift while running and a stop can
   * share its reading with another load starting on the same phase.
   */
  MIN_RATIO: 0.4,
  MAX_RATIO: 2.0,
  /** A start without a stop after this long is dropped (ms). */
  MAX_ON_MS: 24 * 3_600_000,
  /** Open starts kept at once. */
  MAX_OPEN: 64,
};

export const CLUSTERING = {
  /** Same load if power is within this factor on a log scale (0.3 ≈ ±35 %: inverter loads vary). */
  MAX_LOG_POWER_DIFF: 0.3,
  /** ...and the share per phase differs by at most this much in total (L1 distance). */
  MAX_SHARE_DISTANCE: 0.35,
  /** Fewer activations than this and a group is not reported as a load. */
  MIN_COUNT: 3,
  /** A phase carrying at least this share counts as used by the load. */
  PHASE_SHARE: 0.2,
  /** Rhythmic: at least this many activations... */
  RHYTHM_MIN_COUNT: 8,
  /** ...with the time between starts varying less than this (coefficient of variation). */
  RHYTHM_MAX_CV: 0.4,
  /** An activation longer than FACTOR × the load's long runs (90th pct) + SLACK minutes is not that load. */
  MAX_DURATION_FACTOR: 2,
  DURATION_SLACK_MIN: 10,
};

export const STORE = {
  /** Activations kept (days) and at most this many. */
  RETENTION_DAYS: 21,
  MAX_ACTIVATIONS: 20_000,
};

export const SESSIONS = {
  /** Activations of one load closer than this belong to one run of an appliance (ms). */
  GAP_MS: 45 * 60_000,
};
