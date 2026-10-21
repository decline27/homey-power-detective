/**
 * The house meter: which Homey device it is, and how its capabilities become a reading.
 *
 * Automatic choice: the one device Homey Energy treats as the home meter (`energyObj.cumulative`),
 * or else the one device reporting both power and imported energy (Tibber Pulse, P1 readers).
 * Several candidates and no choice made: none (the user picks on the settings page).
 */
import { Reading } from '../engine/engine';
import { Vec3 } from '../engine/types';

export const METER_SETTING = 'house_meter_device_id';
export const NOMINAL_VOLTAGE = 230;
/** The total power must be newer than this (ms)... */
export const MAX_VALUE_AGE_MS = 120_000;
/**
 * ...while a phase value is held as long as the total keeps coming: Homey reports a capability
 * when it changes, so a phase whose current has not moved keeps its last value. Falling back to a
 * total-only reading instead would change the shape of the readings and fake a step.
 */
export const MAX_HOLD_MS = Infinity;

export interface DeviceLike {
  id: string;
  name?: string;
  class?: string;
  driverId?: string;
  capabilities?: string[];
  capabilitiesObj?: Record<string, { value?: unknown; lastUpdated?: unknown } | undefined>;
  energyObj?: { cumulative?: boolean } | null;
}

const has = (d: DeviceLike, cap: string) => Array.isArray(d.capabilities) && d.capabilities.includes(cap);
const isMeter = (d: DeviceLike) => has(d, 'measure_power') && (d.energyObj?.cumulative === true || has(d, 'meter_power.imported'));

export function meterCandidates(devices: DeviceLike[]): Array<{ id: string; name: string; phases: boolean }> {
  return devices
    .filter(isMeter)
    .sort((a, b) => Number(b.energyObj?.cumulative === true) - Number(a.energyObj?.cumulative === true))
    .map(d => ({ id: d.id, name: d.name ?? d.id, phases: has(d, 'measure_current.L1') }));
}

export function pickMeter(devices: DeviceLike[], setting: unknown): DeviceLike | null {
  if (typeof setting === 'string' && setting !== '') return devices.find(d => d.id === setting && has(d, 'measure_power')) ?? null;
  const cumulative = devices.filter(d => has(d, 'measure_power') && d.energyObj?.cumulative === true);
  if (cumulative.length === 1) return cumulative[0];
  if (cumulative.length > 1) return null;
  const meters = devices.filter(isMeter);
  return meters.length === 1 ? meters[0] : null;
}

/** The capabilities read from the meter: total power, and per phase current and voltage when present. */
export const PHASE_CURRENT = ['measure_current.L1', 'measure_current.L2', 'measure_current.L3'];
export const PHASE_VOLTAGE = ['measure_voltage.L1', 'measure_voltage.L2', 'measure_voltage.L3'];

export interface Latest {
  value: number;
  at: number;
}

/**
 * A reading from the latest capability values. Per-phase power is current × voltage (nominal
 * 230 V when the meter has no voltage). A meter without phase currents gives everything on L1:
 * detection then works on the total alone, like a single-phase meter.
 */
export function readingFrom(latest: Map<string, Latest>, now: number): Reading | null {
  const value = (cap: string, maxAge: number): number | null => {
    const v = latest.get(cap);
    return v && Number.isFinite(v.value) && now - v.at <= maxAge ? v.value : null;
  };
  const fresh = (cap: string) => value(cap, MAX_HOLD_MS);
  const total = value('measure_power', MAX_VALUE_AGE_MS);
  if (total === null) return null;
  const currents = PHASE_CURRENT.map(fresh);
  if (currents.every(c => c === null)) return { t: now, w: [total, 0, 0], total };
  if (currents.some(c => c === null)) return null;
  const w = currents.map((c, k) => (c as number) * (fresh(PHASE_VOLTAGE[k]) ?? NOMINAL_VOLTAGE)) as Vec3;
  return { t: now, w, total };
}

/** Latest values straight from a device object (the fallback when live updates stall). */
export function latestFromDevice(d: DeviceLike, now: number): Map<string, Latest> {
  const out = new Map<string, Latest>();
  for (const cap of ['measure_power', ...PHASE_CURRENT, ...PHASE_VOLTAGE]) {
    const c = d.capabilitiesObj?.[cap];
    if (typeof c?.value !== 'number') continue;
    const at = c.lastUpdated ? new Date(c.lastUpdated as string).getTime() : now;
    out.set(cap, { value: c.value, at: Number.isFinite(at) ? at : now });
  }
  return out;
}
