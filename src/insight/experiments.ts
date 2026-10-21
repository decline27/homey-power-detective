/**
 * Switch-off tests: the outside judge for loads no device meters. The user switches something
 * off (a floor thermostat, a breaker) and says which found load they think it is; if that load
 * keeps its rhythm, it was something else. Decided with a Poisson test on how many activations
 * the load would have had in the window, so a load that runs twice a day is not "confirmed" by a
 * quiet hour.
 */

export interface Experiment {
  id: string;
  loadId: string;
  /** What the user switched off, in their words. */
  label: string;
  startedAt: number;
  hours: number;
}

export type ExperimentStatus = 'running' | 'confirmed' | 'rejected' | 'inconclusive';

export interface ExperimentResult {
  status: ExperimentStatus;
  /** Activations expected in the window from the load's own rate. */
  expected: number;
  observed: number;
  /** Chance of seeing this few activations if nothing had been switched off. */
  pValue: number | null;
  text: string;
}

/** P(X <= k) for X ~ Poisson(lambda). */
export function poissonCdf(k: number, lambda: number): number {
  let term = Math.exp(-lambda);
  let sum = term;
  for (let i = 1; i <= k; i++) {
    term *= lambda / i;
    sum += term;
  }
  return Math.min(1, sum);
}

/**
 * @param startsPerHour the load's normal rate, measured before the test
 * @param observed activations of the load that started inside the test window
 */
export function evaluateExperiment(exp: Experiment, now: number, startsPerHour: number, observed: number): ExperimentResult {
  const end = exp.startedAt + exp.hours * 3_600_000;
  const elapsedH = Math.max(0, Math.min(now, end) - exp.startedAt) / 3_600_000;
  const expected = startsPerHour * elapsedH;
  const p = expected > 0 ? poissonCdf(observed, expected) : null;

  if (observed >= Math.max(1, expected / 2) && expected >= 2) {
    return {
      status: 'rejected',
      expected,
      observed,
      pValue: p,
      text: `It kept running (${observed} times, ${expected.toFixed(1)} expected): ${exp.label} is not this load.`,
    };
  }
  if (now < end) {
    return { status: 'running', expected, observed, pValue: p, text: `Running: ${observed} starts so far, ${expected.toFixed(1)} expected by now.` };
  }
  if (observed === 0 && p !== null && p < 0.05) {
    return {
      status: 'confirmed',
      expected,
      observed,
      pValue: p,
      text: `Confirmed: no starts in ${exp.hours} h where ${expected.toFixed(1)} were expected (p = ${p.toFixed(3)}). This load is ${exp.label}.`,
    };
  }
  return {
    status: 'inconclusive',
    expected,
    observed,
    pValue: p,
    text: `Inconclusive: ${observed} starts, ${expected.toFixed(1)} expected. Run the test longer or when the load is busier.`,
  };
}

/** Hours a test needs so that a load at this rate would be expected at least 3 times (p < 0.05 at zero). */
export function hoursNeeded(startsPerHour: number, min = 2, max = 48): number {
  if (!(startsPerHour > 0)) return max;
  return Math.min(max, Math.max(min, Math.ceil(3 / startsPerHour)));
}
