/**
 * What is on now, fitted to what the house meter draws now.
 *
 * The open starts alone over-count: a load that ramped down without a step, or a stop lost in
 * simultaneous switching, stays open until it can be retired (OPEN_STARTS keeps the energy
 * account careful: three hours). On the Homey on 2026-11-25 the open starts added up to 3.7 kW
 * while the meter drew 2.0 kW, with 1.4 kW of starts on a phase drawing 440 W.
 *
 * For the live view each phase's power is shared out instead, in this order:
 *   1. the always-on base (the lowest phase's own base, on each phase: a careful floor);
 *   2. the balanced 3-phase load (the heat pump), from the level tracker, a third per phase;
 *   3. the open starts, newest first: a start is shown while its phases still carry at least
 *      FIT_MIN of it, and only as much as they carry.
 * What no row takes is the rest. Nothing here changes the starts or the energy account.
 */
import { phaseLabel, phaseShare } from '../engine/clustering';
import { LoadCluster, StepEvent, Vec3 } from '../engine/types';

export const LIVE = {
  /** A start is shown while its phases carry at least this share of it. */
  FIT_MIN: 0.6,
  /** A phase step smaller than this (W) is not checked: it is within the meter's noise. */
  PHASE_MIN_W: 80,
  /** An unknown start this evenly spread is a step of the balanced load (each phase ≥ this share). */
  BALANCED_SHARE: 0.22,
};

export interface LiveLoad {
  id: string;
  name: string | null;
  suggestion: string | null;
  phases: string;
  medianW: number;
  /** The Homey device it was matched to, if any. */
  deviceId?: string | null;
}

export interface LiveRow {
  loadId: string | null;
  name: string;
  named: boolean;
  suggestion: string | null;
  phases: string;
  usualW: number | null;
  w: number;
  since: number;
  /** The balanced 3-phase load from the level tracker. */
  heatPump?: boolean;
  /** The Homey device this is (its own reading may be late or frozen), if known. */
  deviceId: string | null;
}

export interface LiveInput {
  now: number;
  /** What the house meter draws per phase, minus the devices subtracted live (W). */
  phaseW: Vec3;
  /** The always-on base of the lowest phase (W), or null before it is known. */
  baseW: number | null;
  /** The balanced load now: its estimate (W), since when, and what to call it. */
  heatPump: { w: number; since: number | null; name: string; named: boolean; deviceId?: string | null } | null;
  /** Open starts with the load each is, newest or oldest first. */
  starts: Array<{ start: StepEvent; cluster: LoadCluster | null }>;
  loads: LiveLoad[];
  /** Loads that are the heat pump's own steps: the level tracker shows them. */
  heatPumpLoadIds: string[];
}

export interface Live {
  rows: LiveRow[];
  /** Per phase: what the rows leave (base and anything unexplained), W. */
  restW: Vec3;
  baseW: number;
  totalW: number;
}

const sum = (v: Vec3) => v[0] + v[1] + v[2];

export function fitLive(x: LiveInput): Live {
  const base = Math.max(0, x.baseW ?? 0);
  const left: Vec3 = x.phaseW.map(w => Math.max(0, w - base)) as Vec3;
  const rows: LiveRow[] = [];
  const hp = x.heatPump && x.heatPump.w > 0 ? x.heatPump : null;
  if (hp) {
    const third = Math.min(hp.w / 3, ...left);
    for (let k = 0; k < 3; k++) left[k] -= third;
    rows.push({ loadId: null, name: hp.name, named: hp.named, suggestion: null, phases: '3-phase', usualW: null, w: Math.round(third * 3), since: hp.since ?? x.now, heatPump: true, deviceId: hp.deviceId ?? null });
  }
  const starts = [...x.starts].filter(s => sum(s.start.delta) > 0).sort((a, b) => b.start.t - a.start.t);
  const byName = new Map<string, LiveRow>();
  for (const { start, cluster } of starts) {
    const share = phaseShare(start.delta);
    if (cluster && x.heatPumpLoadIds.includes(cluster.id) && hp) continue;
    if (!cluster && hp && share.every(s => s >= LIVE.BALANCED_SHARE)) continue;
    const d = start.delta.map(v => Math.max(0, v)) as Vec3;
    const checked = [0, 1, 2].filter(k => d[k] >= LIVE.PHASE_MIN_W);
    if (!checked.length) continue;
    const fit = Math.min(1, ...checked.map(k => left[k] / d[k]));
    if (fit < LIVE.FIT_MIN) continue;
    for (let k = 0; k < 3; k++) left[k] = Math.max(0, left[k] - d[k] * fit);
    const w = sum(d) * fit;
    const load = cluster ? x.loads.find(l => l.id === cluster.id) : undefined;
    const phases = load?.phases ?? phaseLabel(share);
    const name = load?.name ?? (load?.suggestion ? `${load.suggestion} (likely)` : `${Math.round((load?.medianW ?? sum(d)) / 10) * 10} W on ${phases}`);
    const prev = byName.get(name);
    if (prev) {
      prev.w += w;
      prev.since = Math.min(prev.since, start.t);
      continue;
    }
    byName.set(name, { loadId: load?.id ?? null, name, named: !!load?.name, suggestion: load?.suggestion ?? null, phases, usualW: load ? Math.round(load.medianW) : null, w, since: start.t, deviceId: load?.deviceId ?? null });
  }
  rows.push(...byName.values());
  const restW = left.map((v, k) => Math.round(v + Math.min(base, x.phaseW[k]))) as Vec3;
  return {
    rows: rows.map(r => ({ ...r, w: Math.round(r.w) })).filter(r => r.w > 0).sort((a, b) => b.w - a.w),
    restW,
    baseW: Math.round(base),
    totalW: Math.round(sum(x.phaseW)),
  };
}
