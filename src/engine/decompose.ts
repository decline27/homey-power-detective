/**
 * Turns a level change into the starts and stops of loads.
 *
 * Most changes are one load switching: every phase moves the same way, and the change becomes
 * one step, shaped by the phases and sized by the house total.
 *
 * When some phases rise and others fall, two loads switched within one reading. The usual case
 * is a load that is running stopping as another starts (in Kjetil's house the 1.3 kW L1 heater
 * switches off as the 3-phase heat pump starts). Splitting the change by sign gets the started
 * load wrong, because the stopping load hides its share on the shared phase. So the running loads
 * are tried first: if removing one of them leaves a clean rise on every phase, that load stopped
 * and the rest is the load that started. Only if none fits is the change split by sign.
 */
import { DETECTOR } from './config';
import { LevelChange } from './detector';
import { StepEvent, Vec3 } from './types';

export type DecomposeConfig = typeof DETECTOR;

const sum3 = (v: Vec3) => v[0] + v[1] + v[2];

/** Sizes a phase shape by the total: same direction, sum equal to the total change. */
function sized(shape: Vec3, total: number): Vec3 | null {
  const s = sum3(shape);
  if (s === 0 || Math.sign(s) !== Math.sign(total)) return null;
  return shape.map(v => (v / s) * total) as Vec3;
}

export function decompose(c: LevelChange, running: StepEvent[], cfg: DecomposeConfig = DETECTOR): StepEvent[] {
  const noise = cfg.TOL_ABS_W;
  const up = c.phase.map(v => (v > noise ? v : 0)) as Vec3;
  const down = c.phase.map(v => (v < -noise ? v : 0)) as Vec3;
  const mixed = sum3(up) > 0 && sum3(down) < 0;
  const step = (delta: Vec3, raw: Vec3): StepEvent => ({ t: c.t, settledAt: c.settledAt, delta, raw });

  if (!mixed) {
    if (Math.abs(c.total) < cfg.MIN_STEP_W) return [];
    const shape = sum3(up) > 0 ? up : sum3(down) < 0 ? down : null;
    const delta = shape ? sized(shape, c.total) : null;
    return delta && shape ? [step(delta, shape)] : [];
  }

  // Which running load, if it stopped now, leaves a clean rise on every phase?
  let best: { load: StepEvent; residual: Vec3; miss: number } | null = null;
  for (const load of running) {
    const raw = load.raw ?? load.delta;
    const residual = c.phase.map((v, k) => v + raw[k]) as Vec3;
    if (residual.some(v => v < -2 * noise)) continue;
    const miss = residual.reduce((s, v) => s + Math.max(0, -v), 0);
    if (!best || miss <= best.miss) best = { load, residual, miss };
  }
  if (best) {
    const out: StepEvent[] = [step(best.load.delta.map(v => -v) as Vec3, (best.load.raw ?? best.load.delta).map(v => -v) as Vec3)];
    const shape = best.residual.map(v => Math.max(0, v)) as Vec3;
    const total = c.total + sum3(best.load.delta);
    const delta = total >= cfg.MIN_STEP_W ? sized(shape, total) : null;
    if (delta) out.push(step(delta, shape));
    return out;
  }

  // No running load explains it: split by sign, scaling both parts by how the total moved.
  const phaseSum = sum3(c.phase);
  const k = Math.abs(phaseSum) > noise ? c.total / phaseSum : 1;
  const scale = Number.isFinite(k) && k > 0.5 && k < 2 ? k : 1;
  const out: StepEvent[] = [];
  for (const part of [up, down]) {
    const d = part.map(v => v * scale) as Vec3;
    if (Math.abs(sum3(d)) >= cfg.MIN_STEP_W) out.push(step(d, part));
  }
  return out;
}
