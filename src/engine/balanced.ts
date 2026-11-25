/**
 * The balanced 3-phase load (a heat pump's compressor), from the house meter alone.
 *
 * A 3-phase heat pump draws the same on every phase. Single-phase loads raise one phase, so the
 * lowest phase carries the heat pump plus the lowest phase's own small base:
 *
 *   heat pump ≈ 3 × (min(L1, L2, L3) − base)
 *
 * where `base` is what the lowest phase draws with the heat pump off: a low percentile of it over
 * recent days (the heat pump is off now and then on most days, even in the cold). It follows a
 * modulating heat pump that runs for hours without a step, which step pairing cannot. On the
 * Homey's raw record (2026-11-18..25, MELCloud as the answer key): on/off per minute P 0.94,
 * R 0.83, energy ×1.15.
 *
 * It also keeps each day's power over the times it is off, so the always-on base of a day the
 * heat pump ran through the night is not its lowest power, and the house minus the estimate for
 * a day it never stopped. Off-times first: 3 × the lowest phase overshoots a heat pump that leans
 * on that phase (the simulated house: 50 W), and the overshoot lands on the low end the base is
 * read from. On 2026-11-23 the Homey's heat pump was off 6 min all day.
 */
import { DayMeter, DayRecord, localDate } from './day-meter';
import { Vec3 } from './types';

export const BALANCED = {
  /** On above this estimate (W)... */
  ON_W: 300,
  /** ...off below this (W)... */
  OFF_W: 200,
  /** ...once it has held this long (ms). */
  HOLD_MS: 2 * 60_000,
  /** The base is this percentile of a day's lowest-phase power... */
  BASE_PERCENTILE: 0.03,
  /** ...the lowest of these many recent days... */
  BASE_DAYS: 7,
  /** ...a day counted once it has this much data (ms). */
  BASE_MIN_COVER_MS: 6 * 3_600_000,
  /**
   * A phase below this (W) is a live-subtracted device taken out too generously (the spa's
   * estimated 2795 W against 2690 W on L2), not the house: no house draws this little on a phase.
   * Such readings do not teach the base; on the Homey's record they pulled it to 5 W.
   */
  MIN_PHASE_W: 50,
  /** Histogram of the lowest-phase power. */
  BIN_W: 10,
  BINS: 400, // 0..4 kW per phase
  /** On-intervals kept (days). */
  KEEP_DAYS: 14,
  /** Readings further apart leave the time between unknown (ms). */
  MAX_GAP_MS: 90_000,
};

export interface BalancedDay {
  date: string;
  /** kWh of the estimate. */
  kWh: number;
  coveredMs: number;
  /** Seconds spent in each lowest-phase power bin. */
  hist: number[];
}

export interface BalancedInterval {
  start: number;
  end: number;
  /** Mean estimate while on (W). */
  w: number;
}

export interface BalancedSnapshot {
  version: 1;
  days: BalancedDay[];
  intervals: Array<[number, number, number]>;
  rest: DayRecord[];
  net?: DayRecord[];
  /** Lowest-phase histograms learned from the raw record (base only), by day. */
  primed?: Array<{ date: string; coveredMs: number; hist: number[] }>;
}

export class BalancedTracker {
  private days: BalancedDay[] = [];
  private intervals: BalancedInterval[] = [];
  /** The house's power while the balanced load is off, per day: its histogram gives always-on. */
  private rest: DayMeter;
  /** The house's power minus the estimate, per day: always-on for a day it was never off. */
  private net: DayMeter;
  private last: { t: number; est: number } | null = null;
  private on: { start: number; wSum: number; ms: number } | null = null;
  /** Since when the estimate has been on the other side of the threshold. */
  private pending: number | null = null;
  private baseCache: { date: string; w: number | null } | null = null;
  /**
   * Days learned from the raw record at start (see learnBase): they teach the base only. A tracker
   * installed this evening otherwise reads its base from this evening alone, with the heat pump on
   * nearly all of it (2026-11-25: base 395 W, heat pump 195 W while MELCloud's meter said ~1 kW).
   */
  private primed: Array<{ date: string; coveredMs: number; hist: number[] }> = [];

  /** Days with a complete lowest-phase histogram (a day the tracker saw, else one it learned). */
  private baseDays(before: string): Array<{ date: string; hist: number[] }> {
    const seen = this.days.filter(d => d.date < before && d.coveredMs >= this.cfg.BASE_MIN_COVER_MS);
    const have = new Set(seen.map(d => d.date));
    const learned = this.primed.filter(d => d.date < before && !have.has(d.date) && d.coveredMs >= this.cfg.BASE_MIN_COVER_MS);
    return [...seen, ...learned].sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  /** Whether a day still needs learning from the raw record. */
  needsBase(date: string): boolean {
    const known = (d: { date: string; coveredMs: number }) => d.date === date && d.coveredMs >= this.cfg.BASE_MIN_COVER_MS;
    return !this.days.some(known) && !this.primed.some(known);
  }

  /** A past day's lowest-phase histogram, from the raw record: the base only, no energy or runs. */
  learnBase(date: string, hist: number[], coveredMs: number): void {
    if (hist.length !== this.cfg.BINS || !(coveredMs > 0)) return;
    this.primed = [...this.primed.filter(d => d.date !== date), { date, coveredMs, hist: [...hist] }]
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(-this.cfg.KEEP_DAYS);
    this.baseCache = null;
  }

  constructor(private readonly timeZone: string, private readonly cfg = BALANCED) {
    this.rest = new DayMeter(timeZone, undefined, cfg.KEEP_DAYS);
    this.net = new DayMeter(timeZone, undefined, cfg.KEEP_DAYS);
  }

  /** What the lowest phase draws with the balanced load off (W), or null before any data. */
  baseW(now: number): number | null {
    const today = localDate(now, this.timeZone);
    if (this.baseCache?.date === today) return this.baseCache.w;
    const past = this.baseDays(today).slice(-this.cfg.BASE_DAYS);
    const lows = past.map(d => percentile(d.hist, this.cfg.BASE_PERCENTILE, this.cfg.BIN_W)).filter((x): x is number => x !== null);
    const w = lows.length ? Math.min(...lows) : null;
    // Cached for the day only when it came from complete days: before that, today's own data.
    if (w !== null) this.baseCache = { date: today, w };
    return w ?? percentile(this.day(today).hist, this.cfg.BASE_PERCENTILE, this.cfg.BIN_W);
  }

  push(t: number, w: Vec3, total: number): void {
    if (!w.every(Number.isFinite) || !Number.isFinite(total)) {
      this.last = null;
      return;
    }
    const low = Math.max(0, Math.min(w[0], w[1], w[2]));
    const base = this.baseW(t);
    const raw = base === null ? 0 : Math.max(0, 3 * (low - base));
    const prev = this.last;
    // On/off with a hold, so a few seconds of three loads at once is not a heat pump.
    const wantOn = this.on ? raw >= this.cfg.OFF_W : raw >= this.cfg.ON_W;
    if (wantOn !== !!this.on) {
      this.pending ??= t;
      if (t - this.pending >= this.cfg.HOLD_MS) {
        if (wantOn) this.on = { start: this.pending, wSum: 0, ms: 0 };
        else this.close(this.pending);
        this.pending = null;
      }
    } else this.pending = null;
    const est = this.on ? Math.min(raw, total) : 0;
    this.last = { t, est };
    // NaN breaks the off-time meter's span: on-time is not counted in it.
    // Nor do they show the house's always-on: such a reading is left out of both day meters.
    const overTaken = low < this.cfg.MIN_PHASE_W;
    this.rest.push(t, this.on || this.pending !== null || overTaken ? NaN : total);
    this.net.push(t, overTaken ? NaN : Math.max(0, total - est));
    if (!prev || t <= prev.t || t - prev.t > this.cfg.MAX_GAP_MS) return;
    const dt = t - prev.t;
    const day = this.day(localDate(prev.t, this.timeZone));
    day.kWh += (prev.est * dt) / 3.6e9;
    day.coveredMs += dt;
    if (low >= this.cfg.MIN_PHASE_W) day.hist[Math.min(this.cfg.BINS - 1, Math.floor(low / this.cfg.BIN_W))] += dt / 1000;
    if (this.on) {
      this.on.wSum += prev.est * dt;
      this.on.ms += dt;
    }
  }

  private close(end: number): void {
    if (!this.on) return;
    if (end > this.on.start) this.intervals.push({ start: this.on.start, end, w: this.on.ms ? this.on.wSum / this.on.ms : 0 });
    this.on = null;
    const cutoff = end - this.cfg.KEEP_DAYS * 86_400_000;
    if (this.intervals.length && this.intervals[0].end < cutoff) this.intervals = this.intervals.filter(i => i.end >= cutoff);
  }

  private day(date: string): BalancedDay {
    let d = this.days.find(x => x.date === date);
    if (!d) {
      d = { date, kWh: 0, coveredMs: 0, hist: new Array(this.cfg.BINS).fill(0) };
      this.days.push(d);
      this.days.sort((a, b) => (a.date < b.date ? -1 : 1));
      if (this.days.length > this.cfg.KEEP_DAYS) this.days.shift();
    }
    return d;
  }

  /** The estimate now (W), 0 while off. */
  nowW(): number {
    return this.last?.est ?? 0;
  }

  /** Since when it has been on, or null. */
  onSince(): number | null {
    return this.on?.start ?? null;
  }

  /** On-intervals, the running one up to the last reading. */
  allIntervals(): BalancedInterval[] {
    const open = this.on && this.last ? [{ start: this.on.start, end: this.last.t, w: this.on.ms ? this.on.wSum / this.on.ms : 0 }] : [];
    return [...this.intervals, ...open];
  }

  /** kWh per local day. */
  energy(): Array<{ date: string; kWh: number; coveredMs: number }> {
    return this.days.map(d => ({ date: d.date, kWh: d.kWh, coveredMs: d.coveredMs }));
  }

  /** The house's days over the times the balanced load was off (for always-on). */
  restDays(): DayRecord[] {
    return this.rest.all();
  }

  /** The house's days minus the estimate (for always-on on a day it never stopped). */
  netDays(): DayRecord[] {
    return this.net.all();
  }

  snapshot(): BalancedSnapshot {
    return {
      version: 1,
      days: this.days.map(d => ({ ...d, hist: [...d.hist] })),
      intervals: this.intervals.map(i => [i.start, i.end, Math.round(i.w)]),
      rest: this.rest.all(),
      net: this.net.all(),
      primed: this.primed.map(d => ({ ...d, hist: [...d.hist] })),
    };
  }

  static restore(snap: unknown, timeZone: string): BalancedTracker {
    const b = new BalancedTracker(timeZone);
    const s = snap as BalancedSnapshot;
    if (!s || s.version !== 1) return b;
    b.days = (Array.isArray(s.days) ? s.days : [])
      .filter(d => d && typeof d.date === 'string' && Array.isArray(d.hist) && d.hist.length === BALANCED.BINS)
      .slice(-BALANCED.KEEP_DAYS);
    b.intervals = (Array.isArray(s.intervals) ? s.intervals : [])
      .filter(r => Array.isArray(r) && r.length === 3 && r.every(x => Number.isFinite(x)))
      .map(([start, end, w]) => ({ start, end, w }));
    b.rest.restore(Array.isArray(s.rest) ? s.rest : []);
    b.net.restore(Array.isArray(s.net) ? s.net : []);
    b.primed = (Array.isArray(s.primed) ? s.primed : []).filter(d => d && typeof d.date === 'string' && Array.isArray(d.hist) && d.hist.length === BALANCED.BINS && d.coveredMs > 0);
    return b;
  }
}

/** The p-th percentile of a time histogram (W, bin middle), or null when empty. */
function percentile(hist: number[], p: number, binW: number): number | null {
  const total = hist.reduce((s, x) => s + x, 0);
  if (total <= 0) return null;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= p * total) return (i + 0.5) * binW;
  }
  return (hist.length - 0.5) * binW;
}
