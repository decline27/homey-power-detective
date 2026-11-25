/**
 * A past day's lowest-phase histogram from the raw record (src/homey/recorder.ts), for the balanced
 * tracker's base (BalancedTracker.learnBase). The house meter's values are replayed as the app
 * samples them (every SAMPLE_MS, readingFrom), so the histogram is the one the tracker would have
 * built that day. The whole house, not the residual: the live-subtracted devices (the charger, the
 * floor heating on L1, the space heater on L2) seldom touch the lowest phase.
 */
import { BALANCED } from '../engine/balanced';
import { Latest, PHASE_CURRENT, PHASE_VOLTAGE, readingFrom } from './meter';

const CAP: Record<string, string> = {
  P: 'measure_power',
  I1: PHASE_CURRENT[0],
  I2: PHASE_CURRENT[1],
  I3: PHASE_CURRENT[2],
  U1: PHASE_VOLTAGE[0],
  U2: PHASE_VOLTAGE[1],
  U3: PHASE_VOLTAGE[2],
};

export function lowestPhaseDay(csv: string, sampleMs = 10_000, cfg = BALANCED): { coveredMs: number; hist: number[] } {
  const events: Array<{ t: number; cap: string; v: number }> = [];
  for (const line of csv.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [ts, key, val] = line.split(',');
    const cap = CAP[key];
    const t = Number(ts);
    const v = Number(val);
    if (cap && Number.isFinite(t) && Number.isFinite(v)) events.push({ t, cap, v });
  }
  const hist = new Array(cfg.BINS).fill(0);
  let coveredMs = 0;
  if (!events.length) return { coveredMs, hist };
  events.sort((a, b) => a.t - b.t);
  const latest = new Map<string, Latest>();
  let k = 0;
  let prev: { t: number; low: number } | null = null;
  const from = Math.ceil(events[0].t / sampleMs) * sampleMs;
  const to = events[events.length - 1].t;
  for (let tick = from; tick <= to; tick += sampleMs) {
    for (; k < events.length && events[k].t <= tick; k++) latest.set(events[k].cap, { value: events[k].v, at: events[k].t });
    const r = readingFrom(latest, tick);
    if (!r || !r.w.every(Number.isFinite) || (r.w[1] === 0 && r.w[2] === 0)) {
      prev = null;
      continue;
    }
    const low = Math.max(0, Math.min(r.w[0], r.w[1], r.w[2]));
    if (prev && tick - prev.t <= cfg.MAX_GAP_MS) {
      const dt = tick - prev.t;
      coveredMs += dt;
      if (prev.low >= cfg.MIN_PHASE_W) hist[Math.min(cfg.BINS - 1, Math.floor(prev.low / cfg.BIN_W))] += dt / 1000;
    }
    prev = { t: tick, low };
  }
  return { coveredMs, hist };
}
