/**
 * A day's energy account: every kWh the house meter counted, in exactly one row.
 *
 *   house meter = metered devices (their own meters: exact)
 *               + found loads (detected on what the meters leave, estimated)
 *               + always-on (lowest steady power of what is left, estimated)
 *               + heating from outdoor temperature (estimated: from what is unexplained, then
 *                 from what looked always-on; never from meters or found loads)
 *               + unexplained
 *
 * When the parts add up to more than the meter (timing at day edges, a meter outage, a load
 * counted by both), the estimates give way first, then the meters, and the excess is reported.
 */

export interface AccountInput {
  date: string;
  totalKWh: number;
  coveredHours: number;
  /** Devices that measure themselves, energy from their own meters. */
  metered: Array<{ id: string; name: string; kWh: number }>;
  alwaysOnKWh: number;
  alwaysOnW: number | null;
  /** Found loads; `deviceId` when the load was matched to a metered device. */
  loads: Array<{ loadId: string; name: string; kWh: number; deviceId: string | null }>;
  /** Heating explained by outdoor temperature, or null when no model yet. */
  weatherKWh: number | null;
}

export type AccountKind = 'metered' | 'load' | 'always_on' | 'weather' | 'unexplained';

export interface AccountRow {
  key: string;
  kind: AccountKind;
  name: string;
  kWh: number;
  share: number;
  /** From a meter (true) or estimated (false). */
  exact: boolean;
}

export interface DayAccount {
  date: string;
  totalKWh: number;
  coveredHours: number;
  alwaysOnW: number | null;
  rows: AccountRow[];
  /** Share of the day in a row other than "unexplained" (0..1). */
  explainedShare: number;
  /** How much the parts exceeded the meter before they were fitted (kWh). */
  overlapKWh: number;
}

const pos = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0);

/** Shrinks `values` proportionally by up to `excess`; returns what was taken. */
function shrink(values: number[], excess: number): number {
  const total = values.reduce((s, v) => s + v, 0);
  if (excess <= 0 || total <= 0) return 0;
  const take = Math.min(excess, total);
  const f = 1 - take / total;
  for (let i = 0; i < values.length; i++) values[i] *= f;
  return take;
}

export function buildAccount(x: AccountInput): DayAccount {
  const total = pos(x.totalKWh);
  const meteredIds = new Set(x.metered.map(m => m.id));
  const metered = x.metered.map(m => ({ ...m, kWh: pos(m.kWh) }));
  // A load matched to a device with its own energy meter is that device's energy already.
  const loads = x.loads
    .filter(l => !(l.deviceId && meteredIds.has(l.deviceId)))
    .map(l => ({ ...l, kWh: pos(l.kWh) }))
    .sort((a, b) => b.kWh - a.kWh);

  const loadKWh = loads.map(l => l.kWh);
  const alwaysOn = [pos(x.alwaysOnKWh)];
  const meterKWh = metered.map(m => m.kWh);
  const sum = () => [...loadKWh, ...alwaysOn, ...meterKWh].reduce((s, v) => s + v, 0);

  const overlapKWh = Math.max(0, sum() - total);
  let excess = overlapKWh;
  excess -= shrink(loadKWh, excess);
  excess -= shrink(alwaysOn, excess);
  shrink(meterKWh, excess);

  // Heating explained by the weather: first from what is unexplained, then from what looked
  // always-on (radiators running all day in the cold set the day's lowest power too).
  const rest = Math.max(0, total - sum());
  const weather = Math.min(pos(x.weatherKWh ?? 0), rest + alwaysOn[0]);
  const fromAlwaysOn = Math.max(0, weather - rest);
  alwaysOn[0] -= fromAlwaysOn;
  const unexplained = rest - (weather - fromAlwaysOn);

  const share = (kWh: number) => (total > 0 ? kWh / total : 0);
  const rows: AccountRow[] = [
    ...metered.map((m, i) => ({ key: `device:${m.id}`, kind: 'metered' as const, name: m.name, kWh: meterKWh[i], exact: true })),
    ...loads.map((l, i) => ({ key: `load:${l.loadId}`, kind: 'load' as const, name: l.name, kWh: loadKWh[i], exact: false })),
    { key: 'always_on', kind: 'always_on' as const, name: 'Always on', kWh: alwaysOn[0], exact: false },
    { key: 'weather', kind: 'weather' as const, name: 'Heating (from outdoor temperature)', kWh: weather, exact: false },
    { key: 'unexplained', kind: 'unexplained' as const, name: 'Unexplained', kWh: unexplained, exact: false },
  ]
    .filter(r => r.kWh > 0)
    .map(r => ({ ...r, share: share(r.kWh) }));

  return {
    date: x.date,
    totalKWh: total,
    coveredHours: x.coveredHours,
    // What weather heating took from always-on lowers its power too.
    alwaysOnW: x.alwaysOnW === null || fromAlwaysOn <= 0 || x.coveredHours <= 0 ? x.alwaysOnW : (alwaysOn[0] * 1000) / x.coveredHours,
    rows,
    explainedShare: total > 0 ? 1 - unexplained / total : 0,
    overlapKWh,
  };
}
