/**
 * Devices that meter themselves (EV charger, spa, heat pump, smart plugs), used two ways:
 *
 *   power report ──> the same change on the Pulse? ──> phase share + report delay, per device
 *        │                                               │
 *        │               fast (≤ 20 s) and consistent ── yes ──> subtracted live from the
 *        │               reading before detection, starting at a moment the device is off
 *        │                                           └─ no ──> energy only (MELCloud: minutes late)
 *        └── energy counter (or power, integrated) ──> kWh per device per local day: exact
 *
 * Subtracting what is already known leaves detection the loads nothing meters (floor heating,
 * oven, kettle): the on/off loads it finds best. Learning the phases from the Pulse needs no
 * setup and catches devices whose reports do not match the house meter (behind solar, wrong).
 */
import { localDate } from '../engine/day-meter';
import { Reading } from '../engine/engine';
import { Vec3 } from '../engine/types';

export const METERED = {
  /** A device change this big (W) is looked for on the house meter. */
  MIN_CHANGE_W: 200,
  /** A device counts as running above this (W). */
  ON_W: 50,
  /** The house meter step may come this much before the device's report (ms)... */
  SEARCH_BEFORE_MS: 5 * 60_000,
  /** ...or this much after it. */
  SEARCH_AFTER_MS: 30_000,
  /** Mean power on each side of a candidate step (ms). */
  WINDOW_MS: 30_000,
  /** The house meter step must match the device's change to within this. */
  MATCH_TOL_W: 120,
  MATCH_TOL_REL: 0.25,
  /** Outcomes remembered per device, and matches needed. */
  OUTCOMES: 10,
  MIN_MATCHES: 3,
  /** Live subtraction only for devices reporting within this (median, ms). */
  MAX_LAG_MS: 20_000,
  /** Phase shares of the matches must agree to within this... */
  MAX_SHARE_SPREAD: 0.15,
  /** ...for this many of them. */
  MIN_AGREEING: 0.75,
  /** More misses than this and the device does not show on the house meter. */
  MAX_MISS_RATE: 0.5,
  /** A device "on" without a report for this long is not trusted (ms). */
  STALE_MS: 3 * 3_600_000,
  /** Integrating power: longest gap between readings counted (ms). */
  MAX_GAP_MS: 90_000,
  /** A counter step above this (kWh) is a new counter, not energy. */
  MAX_COUNTER_STEP_KWH: 50,
  KEEP_DAYS: 35,
};

interface Outcome {
  hit: boolean;
  share?: Vec3;
  lagMs?: number;
}

interface Device {
  id: string;
  name: string;
  w: number | null;
  at: number;
  counter: { kWh: number; at: number } | null;
  hasCounter: boolean;
  outcomes: Outcome[];
  live: boolean;
  days: Record<string, number>;
}

export interface MeteredStatus {
  id: string;
  name: string;
  live: boolean;
  share: Vec3 | null;
  lagMs: number | null;
  matches: number;
  misses: number;
}

interface Snapshot {
  version: 1;
  devices: Device[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class MeteredDevices {
  private devices = new Map<string, Device>();
  private buffer: Reading[] = [];
  private pending: Array<{ id: string; t: number; dW: number }> = [];
  /** Every device change of the last minutes, to explain away simultaneous ones. */
  private recent: Array<{ id: string; t: number; dW: number }> = [];
  private lastObserved: number | null = null;

  constructor(private readonly timeZone: string) {}

  private device(id: string, name?: string): Device {
    let d = this.devices.get(id);
    if (!d) {
      d = { id, name: name ?? id, w: null, at: 0, counter: null, hasCounter: false, outcomes: [], live: false, days: {} };
      this.devices.set(id, d);
    }
    if (name) d.name = name;
    return d;
  }

  /** A device's power, as Homey reported it at `t`. */
  power(id: string, name: string, w: number, t: number): void {
    if (!Number.isFinite(w)) return;
    const d = this.device(id, name);
    if (d.w !== null && Math.abs(w - d.w) >= METERED.MIN_CHANGE_W) {
      this.pending.push({ id, t, dW: w - d.w });
      this.recent.push({ id, t, dW: w - d.w });
    }
    d.w = w;
    d.at = t;
    this.updateLive(d);
  }

  /** A device's energy counter (kWh), as Homey reported it at `t`. */
  counter(id: string, kWh: number, t: number): void {
    if (!Number.isFinite(kWh) || kWh < 0) return;
    const d = this.device(id);
    d.hasCounter = true;
    const prev = d.counter;
    d.counter = { kWh, at: t };
    if (!prev || t <= prev.at) return;
    let delta = kWh - prev.kWh;
    // A counter that starts again from zero (daily counters): the new value is the energy since.
    if (delta < 0) delta = kWh < METERED.MAX_COUNTER_STEP_KWH ? kWh : 0;
    if (delta > METERED.MAX_COUNTER_STEP_KWH) return;
    this.add(d, t, delta);
  }

  private add(d: Device, t: number, kWh: number): void {
    if (kWh <= 0) return;
    const date = localDate(t, this.timeZone);
    d.days[date] = (d.days[date] ?? 0) + kWh;
    const dates = Object.keys(d.days).sort();
    dates.slice(0, Math.max(0, dates.length - METERED.KEEP_DAYS)).forEach(k => delete d.days[k]);
  }

  /** Every raw house-meter reading: kept briefly to find device changes in it. */
  observe(r: Reading): void {
    if (this.lastObserved !== null && r.t > this.lastObserved && r.t - this.lastObserved <= METERED.MAX_GAP_MS) {
      const dt = r.t - this.lastObserved;
      for (const d of this.devices.values()) {
        if (!d.hasCounter && d.w !== null && d.w > 0 && !this.stale(d, r.t)) this.add(d, r.t, (d.w * dt) / 3.6e9);
      }
    }
    this.lastObserved = r.t;
    this.buffer.push(r);
    const keepFrom = r.t - METERED.SEARCH_BEFORE_MS - METERED.SEARCH_AFTER_MS - 2 * METERED.WINDOW_MS;
    while (this.buffer.length && this.buffer[0].t < keepFrom) this.buffer.shift();
    while (this.recent.length && this.recent[0].t < keepFrom - METERED.SEARCH_BEFORE_MS) this.recent.shift();
    const due = this.pending.filter(e => e.t + METERED.SEARCH_AFTER_MS + METERED.WINDOW_MS <= r.t);
    if (!due.length) return;
    this.pending = this.pending.filter(e => !due.includes(e));
    for (const e of due) this.learn(e);
  }

  private total(r: Reading): number {
    return Number.isFinite(r.total) ? (r.total as number) : r.w[0] + r.w[1] + r.w[2];
  }

  private mean(from: number, to: number): { w: Vec3; total: number } | null {
    const rs = this.buffer.filter(r => r.t >= from && r.t < to);
    if (!rs.length) return null;
    const w: Vec3 = [0, 0, 0];
    let total = 0;
    for (const r of rs) {
      for (let k = 0; k < 3; k++) w[k] += r.w[k] / rs.length;
      total += this.total(r) / rs.length;
    }
    return { w, total };
  }

  /**
   * Finds the device's change on the house meter: the step that best matches its size. Another
   * device changing at the same moment is taken out when it is known (its share and delay are
   * learned); when it is not, the two cannot be told apart and the change teaches nothing.
   */
  private learn(e: { id: string; t: number; dW: number }): void {
    const d = this.devices.get(e.id);
    if (!d) return;
    const others = this.recent
      .filter(o => o.id !== e.id)
      .map(o => {
        const od = this.devices.get(o.id);
        const l = od ? this.learned(od) : null;
        const known = !!l && od!.outcomes.filter(x => x.hit).length >= METERED.MIN_MATCHES;
        return { ...o, known, share: l?.share ?? null, stepAt: known ? o.t - (l as { lagMs: number }).lagMs : o.t };
      });
    if (others.some(o => !o.known && Math.abs(o.t - e.t) <= 2 * METERED.WINDOW_MS)) return;
    const tol = Math.max(METERED.MATCH_TOL_W, METERED.MATCH_TOL_REL * Math.abs(e.dW));
    let best: { err: number; dist: number; t: number; dw: Vec3; dT: number } | null = null;
    for (const c of this.buffer) {
      if (c.t < e.t - METERED.SEARCH_BEFORE_MS || c.t > e.t + METERED.SEARCH_AFTER_MS) continue;
      const before = this.mean(c.t - METERED.WINDOW_MS, c.t);
      const after = this.mean(c.t, c.t + METERED.WINDOW_MS);
      if (!before || !after) continue;
      let dT = after.total - before.total;
      const dw: Vec3 = [after.w[0] - before.w[0], after.w[1] - before.w[1], after.w[2] - before.w[2]];
      for (const o of others) {
        if (!o.known || Math.abs(o.stepAt - c.t) > METERED.WINDOW_MS) continue;
        dT -= o.dW;
        for (let k = 0; k < 3; k++) dw[k] -= o.dW * (o.share as Vec3)[k];
      }
      if (Math.sign(dT) !== Math.sign(e.dW)) continue;
      const err = Math.abs(dT - e.dW);
      if (err > tol) continue;
      const dist = Math.abs(e.t - c.t);
      if (!best || err < best.err - 1e-9 || (Math.abs(err - best.err) <= 1e-9 && dist < best.dist)) {
        best = { err, dist, t: c.t, dT, dw };
      }
    }
    if (best) {
      const raw = best.dw.map(x => Math.max(0, x / best!.dT)) as Vec3;
      const s = raw[0] + raw[1] + raw[2] || 1;
      d.outcomes.push({ hit: true, share: raw.map(x => x / s) as Vec3, lagMs: e.t - best.t });
    } else {
      d.outcomes.push({ hit: false });
    }
    if (d.outcomes.length > METERED.OUTCOMES) d.outcomes.splice(0, d.outcomes.length - METERED.OUTCOMES);
    this.updateLive(d);
  }

  private learned(d: Device): { share: Vec3; lagMs: number; qualified: boolean } | null {
    const hits = d.outcomes.filter(o => o.hit) as Array<Required<Outcome>>;
    if (!hits.length) return null;
    const share = [0, 1, 2].map(k => median(hits.map(h => h.share[k]))) as Vec3;
    const sum = share[0] + share[1] + share[2] || 1;
    const norm = share.map(x => x / sum) as Vec3;
    const lagMs = median(hits.map(h => h.lagMs));
    const agreeing = hits.filter(h => [0, 1, 2].every(k => Math.abs(h.share[k] - norm[k]) <= METERED.MAX_SHARE_SPREAD)).length;
    const misses = d.outcomes.length - hits.length;
    const qualified =
      hits.length >= METERED.MIN_MATCHES &&
      misses / d.outcomes.length <= METERED.MAX_MISS_RATE &&
      Math.abs(lagMs) <= METERED.MAX_LAG_MS &&
      agreeing / hits.length >= METERED.MIN_AGREEING;
    return { share: norm, lagMs, qualified };
  }

  /** Live subtraction starts and stops only while the device is off: no step that is not there. */
  private updateLive(d: Device): void {
    if ((d.w ?? 0) >= METERED.ON_W) return;
    d.live = this.learned(d)?.qualified ?? false;
  }

  private stale(d: Device, t: number): boolean {
    return t - d.at > METERED.STALE_MS;
  }

  /** The reading with live devices taken out, per phase; never below zero. */
  residual(r: Reading): Reading {
    const w: Vec3 = [...r.w];
    let total = this.total(r);
    for (const d of this.devices.values()) {
      if (!d.live || d.w === null || d.w <= 0 || this.stale(d, r.t)) continue;
      const l = this.learned(d);
      if (!l) continue;
      for (let k = 0; k < 3; k++) w[k] -= d.w * l.share[k];
      total -= d.w;
    }
    return { t: r.t, w: w.map(x => Math.max(0, x)) as Vec3, total: Math.max(0, total) };
  }

  energyOn(date: string): Array<{ id: string; name: string; kWh: number }> {
    return [...this.devices.values()]
      .filter(d => (d.days[date] ?? 0) > 0)
      .map(d => ({ id: d.id, name: d.name, kWh: d.days[date] }));
  }

  running(now: number): Array<{ id: string; name: string; w: number }> {
    return [...this.devices.values()]
      .filter(d => d.w !== null && d.w > METERED.ON_W && !this.stale(d, now))
      .map(d => ({ id: d.id, name: d.name, w: d.w as number }))
      .sort((a, b) => b.w - a.w);
  }

  status(): MeteredStatus[] {
    return [...this.devices.values()].map(d => {
      const l = this.learned(d);
      return {
        id: d.id,
        name: d.name,
        live: d.live,
        share: l?.share ?? null,
        lagMs: l?.lagMs ?? null,
        matches: d.outcomes.filter(o => o.hit).length,
        misses: d.outcomes.filter(o => !o.hit).length,
      };
    });
  }

  snapshot(): Snapshot {
    return { version: 1, devices: [...this.devices.values()] };
  }

  static restore(snap: unknown, timeZone: string): MeteredDevices {
    const m = new MeteredDevices(timeZone);
    const s = snap as Snapshot;
    if (!s || s.version !== 1 || !Array.isArray(s.devices)) return m;
    for (const d of s.devices) {
      if (!d || typeof d.id !== 'string') continue;
      m.devices.set(d.id, {
        id: d.id,
        name: String(d.name ?? d.id),
        w: Number.isFinite(d.w) ? d.w : null,
        at: Number(d.at) || 0,
        counter: d.counter && Number.isFinite(d.counter.kWh) ? { kWh: d.counter.kWh, at: Number(d.counter.at) || 0 } : null,
        hasCounter: d.hasCounter === true,
        outcomes: Array.isArray(d.outcomes) ? d.outcomes.slice(-METERED.OUTCOMES) : [],
        live: d.live === true,
        days: d.days && typeof d.days === 'object' ? { ...d.days } : {},
      });
    }
    return m;
  }
}
