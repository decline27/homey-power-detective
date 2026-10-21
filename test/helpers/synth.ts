/** Synthetic three-phase house: deterministic, so tests can assert exact behaviour. */
import { Vec3 } from '../../src/engine/types';

export interface SynthLoad {
  /** Per-phase power while on (W). */
  w: Vec3;
  /** On-intervals [start, end) in ms. */
  on: Array<[number, number]>;
  /** Ramp length at switch-on (ms), like an inverter compressor. */
  rampMs?: number;
}

export const T0 = Date.UTC(2026, 9, 21, 0, 0, 0);
export const MIN = 60_000;

/** Readings every `stepMs` from t0 for `durationMs`: base load plus the loads, plus small noise. */
export function synthHouse(loads: SynthLoad[], durationMs: number, opts: { stepMs?: number; base?: Vec3; noise?: number; t0?: number } = {}) {
  const step = opts.stepMs ?? 10_000;
  const base = opts.base ?? [150, 120, 100];
  const noise = opts.noise ?? 10;
  const t0 = opts.t0 ?? T0;
  const out: Array<{ t: number; w: Vec3; total: number }> = [];
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  for (let t = t0; t < t0 + durationMs; t += step) {
    const w: Vec3 = [base[0] + rnd() * noise, base[1] + rnd() * noise, base[2] + rnd() * noise];
    for (const l of loads) {
      for (const [a, b] of l.on) {
        if (t >= a && t < b) {
          const f = l.rampMs ? Math.min(1, (t - a + step) / l.rampMs) : 1;
          for (let k = 0; k < 3; k++) w[k] += l.w[k] * f;
        }
      }
    }
    out.push({ t, w, total: w[0] + w[1] + w[2] });
  }
  return out;
}

/** Repeating on-intervals: `minutesOn` every `periodMin`, starting at offsetMin. */
export function every(periodMin: number, minutesOn: number, count: number, offsetMin = 0, t0 = T0): Array<[number, number]> {
  return Array.from({ length: count }, (_, i) => {
    const s = t0 + (offsetMin + i * periodMin) * MIN;
    return [s, s + minutesOn * MIN] as [number, number];
  });
}
