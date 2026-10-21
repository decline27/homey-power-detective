/**
 * Findings: what is worth doing, in money per month, each with a way to check it.
 *
 * Every finding is a rule over measured loads, not a guess: the numbers in its text come from the
 * activations. A finding that names a cause it cannot see ("this is probably floor heating") says
 * so and offers a switch-off test, which the experiments module then judges.
 */
import { Activation, LoadCluster, activationKWh } from '../engine/types';
import { PriceAt, activationEnergy } from './ledger';
import { dayBounds } from './time';
import { localDate } from '../engine/day-meter';

export type FindingKind = 'rhythmic-heater' | 'short-cycling' | 'base-load' | 'shiftable';

export interface Finding {
  id: string;
  kind: FindingKind;
  loadId?: string;
  title: string;
  detail: string;
  kWhPerMonth: number;
  costPerMonth: number | null;
  /** What acting on it would save per month, when that can be worked out. */
  savingPerMonth: number | null;
  confidence: 'low' | 'medium' | 'high';
  /** A switch-off test that would confirm what the load is. */
  experimentHours?: number;
}

export interface FindingInputs {
  loads: LoadCluster[];
  /** Names given by the user or taken from a matched device, by load id. */
  names: Record<string, string>;
  /** Load ids that are the heat pump (matched to it, or named so). */
  heatPumpLoadIds: string[];
  /** Always-on power (W), from the day ledger. */
  baseloadW: number | null;
  /** Average price per kWh over the period, for monthly figures. */
  avgPrice: number | null;
  currency: string;
  /** Hourly prices for the shift finding (optional). */
  price?: PriceAt;
  /** Coefficient of performance assumed for heat moved to the heat pump. */
  heatPumpCop: number;
  timeZone: string;
}

export const FINDING_LIMITS = {
  /** A rhythmic load below this is not worth a finding (kWh/day). */
  MIN_HEATER_KWH_DAY: 1,
  HEATER_MIN_W: 400,
  HEATER_MAX_W: 4000,
  /** Short cycling: runs this short or shorter (minutes)... */
  SHORT_RUN_MIN: 10,
  /** ...this often (starts/day). */
  SHORT_CYCLE_STARTS_DAY: 24,
  /** A base load below this is normal for a home (W). */
  MIN_BASE_W: 100,
  /** A load is shiftable if a run takes at least this much (kWh). */
  SHIFT_MIN_RUN_KWH: 0.5,
  /** ...and moving it would save at least this share of its cost. */
  SHIFT_MIN_SHARE: 0.15,
};

const round = (x: number, d = 0) => Math.round(x * 10 ** d) / 10 ** d;
const money = (x: number | null, currency: string) => (x === null ? '' : `${round(x)} ${currency}`);

export function buildFindings(inp: FindingInputs, limits = FINDING_LIMITS): Finding[] {
  const out: Finding[] = [];
  const monthly = (kWhPerDay: number) => kWhPerDay * 30;
  const cost = (kWh: number) => (inp.avgPrice === null ? null : kWh * inp.avgPrice);

  for (const c of inp.loads) {
    const name = inp.names[c.id];
    const isHeatPump = inp.heatPumpLoadIds.includes(c.id);

    if (
      !isHeatPump &&
      c.rhythmic &&
      c.phases !== '3-phase' &&
      c.medianW >= limits.HEATER_MIN_W &&
      c.medianW <= limits.HEATER_MAX_W &&
      c.kWhPerDay >= limits.MIN_HEATER_KWH_DAY
    ) {
      const kWh = monthly(c.kWhPerDay);
      const costM = cost(kWh);
      const period = c.periodMinutes ?? 0;
      out.push({
        id: `rhythmic-heater:${c.id}`,
        kind: 'rhythmic-heater',
        loadId: c.id,
        title: `${name ?? `A ${round(c.medianW, -1)} W load on ${c.phases}`} runs every ${round(period)} min, ${round(c.kWhPerDay, 1)} kWh/day`,
        detail:
          `It switches on for about ${round(c.medianMinutes)} min every ${round(period)} min, day and night: a thermostat drives it ` +
          `(floor heating, a panel heater, a water heater or a drying cabinet). ` +
          `That is ${round(kWh)} kWh a month${costM === null ? '' : `, about ${money(costM, inp.currency)}`}. ` +
          `If it heats rooms the heat pump also heats, the heat pump would make the same heat for about 1/${inp.heatPumpCop} of the electricity.`,
        kWhPerMonth: kWh,
        costPerMonth: costM,
        savingPerMonth: costM === null ? null : costM * (1 - 1 / inp.heatPumpCop),
        confidence: name ? 'high' : c.count >= 24 ? 'medium' : 'low',
        experimentHours: Math.max(3, Math.ceil((3 * period) / 60)),
      });
    }

    const looksLikeHeatPump = isHeatPump || (c.phases === '3-phase' && c.medianW >= 300 && c.medianW <= 4000);
    if (looksLikeHeatPump && c.medianMinutes <= limits.SHORT_RUN_MIN && c.startsPerDay >= limits.SHORT_CYCLE_STARTS_DAY) {
      out.push({
        id: `short-cycling:${c.id}`,
        kind: 'short-cycling',
        loadId: c.id,
        title: `${name ?? (isHeatPump ? 'The heat pump' : 'A 3-phase load (likely the heat pump)')} starts ${round(c.startsPerDay)} times a day and runs ${round(c.medianMinutes, 1)} min`,
        detail:
          'Short runs mean the compressor makes more heat than the house takes even at its lowest speed: every start wastes ' +
          'the warm-up and wears the compressor. Fewer, longer runs come from a lower flow temperature (heating curve), ' +
          'more open circuits (thermostats and valves open) or more water volume in the system.',
        kWhPerMonth: monthly(c.kWhPerDay),
        costPerMonth: cost(monthly(c.kWhPerDay)),
        savingPerMonth: null,
        confidence: isHeatPump ? 'high' : 'medium',
      });
    }
  }

  if (inp.baseloadW !== null && inp.baseloadW >= limits.MIN_BASE_W) {
    const kWh = (inp.baseloadW * 24 * 30) / 1000;
    out.push({
      id: 'base-load',
      kind: 'base-load',
      title: `The house never draws less than ${round(inp.baseloadW, -1)} W`,
      detail:
        `Always-on loads (network, standby, fridges and freezers, circulation pumps, heating cables) take ${round(kWh)} kWh a month` +
        `${cost(kWh) === null ? '' : `, about ${money(cost(kWh), inp.currency)}`}. Each 10 W always on is 88 kWh a year.`,
      kWhPerMonth: kWh,
      costPerMonth: cost(kWh),
      savingPerMonth: null,
      confidence: 'high',
    });
  }

  if (inp.price) {
    for (const c of inp.loads) {
      if (c.rhythmic || inp.heatPumpLoadIds.includes(c.id)) continue;
      const shift = shiftSaving(c.activations, inp.price, inp.timeZone);
      if (!shift || shift.runs < 3) continue;
      const kWhRun = shift.kWh / shift.runs;
      if (kWhRun < limits.SHIFT_MIN_RUN_KWH || shift.actual <= 0 || shift.saving / shift.actual < limits.SHIFT_MIN_SHARE) continue;
      const perMonth = (shift.saving / shift.days) * 30;
      out.push({
        id: `shiftable:${c.id}`,
        kind: 'shiftable',
        loadId: c.id,
        title: `${inp.names[c.id] ?? `A ${round(c.medianW, -1)} W load on ${c.phases}`}: ${money(perMonth, inp.currency)}/month cheaper at the day's cheapest hours`,
        detail:
          `${shift.runs} runs of about ${round(kWhRun, 1)} kWh cost ${money(shift.actual, inp.currency)}; started in the cheapest hours of ` +
          `the same days they would have cost ${money(shift.actual - shift.saving, inp.currency)}.`,
        kWhPerMonth: (shift.kWh / shift.days) * 30,
        costPerMonth: (shift.actual / shift.days) * 30,
        savingPerMonth: perMonth,
        confidence: inp.names[c.id] ? 'high' : 'medium',
      });
    }
  }

  // Ranked by the money involved; without prices, by energy.
  const weight = (f: Finding) => f.costPerMonth ?? f.kWhPerMonth;
  return out.sort((a, b) => weight(b) - weight(a));
}

/** What the activations cost, and what they would have cost started at the cheapest hour of the same day. */
export function shiftSaving(
  acts: Activation[],
  price: PriceAt,
  timeZone: string
): { runs: number; kWh: number; actual: number; saving: number; days: number } | null {
  let actual = 0;
  let best = 0;
  let kWh = 0;
  let runs = 0;
  const days = new Set<string>();
  for (const a of acts) {
    const date = localDate(a.start, timeZone);
    const bounds = dayBounds(date, timeZone);
    const dur = a.end - a.start;
    const now = activationEnergy(a, a.start, a.end, price).cost;
    if (now === null) continue;
    let cheapest = now;
    for (let s = bounds.start; s + dur <= bounds.end; s += 3_600_000) {
      const c = activationEnergy({ ...a, start: s, end: s + dur }, s, s + dur, price).cost;
      if (c !== null && c < cheapest) cheapest = c;
    }
    actual += now;
    best += cheapest;
    kWh += activationKWh(a);
    runs++;
    days.add(date);
  }
  if (runs === 0) return null;
  return { runs, kWh, actual, saving: actual - best, days: Math.max(days.size, 1) };
}

