/**
 * Devices that measure themselves (an EV charger, the heat pump through MELCloud, smart plugs):
 * when each was on, kept as intervals. They name the loads that coincide with them and judge,
 * live, how well the engine finds them from the house meter alone.
 */
import { Reference } from '../engine/labels';
import { Interval } from '../engine/score';
import { DeviceLike } from './meter';

export const REFERENCES = {
  /** A device counts as on above this (W)... */
  ON_W: 50,
  /**
   * ...or this share of its peak, up to ON_CAP_W: a spa's 95 W circulation pump runs for hours
   * around its heats, and "on" should be the heater and jets, not that.
   */
  ON_PEAK_SHARE: 0.2,
  ON_CAP_W: 400,
  /** The peak fades to half over this long, so a new device or a lowered setting is followed (ms). */
  PEAK_HALF_LIFE_MS: 14 * 86_400_000,
  /** Intervals kept per device, and days. */
  MAX_INTERVALS: 3000,
  RETENTION_DAYS: 21,
  /** Without a new reading for this long, an open interval is closed at the last reading (ms). */
  MAX_SILENCE_MS: 15 * 60_000,
};

interface Track {
  name: string;
  heatPump: boolean;
  /** Homey device class ("evcharger", "heater", "thermostat"...). */
  cls?: string;
  /** Highest power seen, fading (W). */
  peakW?: number;
  intervals: Interval[];
  open: Interval | null;
  lastSeen: number;
}

export interface ReferenceSnapshot {
  version: 1;
  tracks: Record<string, Track>;
}

/**
 * A device that measures a load: reports power, and is not another whole-house meter, a solar
 * inverter or a battery, nor one of `exclude` (this app's own devices, the house meter).
 */
export function isLoadDevice(d: DeviceLike, exclude: Set<string>): boolean {
  if (exclude.has(d.id)) return false;
  const power = d.capabilitiesObj?.measure_power?.value;
  if (!Array.isArray(d.capabilities) || !d.capabilities.includes('measure_power') || typeof power !== 'number') return false;
  if (d.energyObj?.cumulative === true || d.capabilities.includes('meter_power.imported')) return false;
  if (d.class === 'solarpanel' || d.class === 'battery' || d.capabilities.includes('meter_power.exported')) return false;
  return true;
}

/** The power above which a device with this peak counts as on (W). */
export function onThresholdW(peakW: number | undefined): number {
  return Math.min(REFERENCES.ON_CAP_W, Math.max(REFERENCES.ON_W, REFERENCES.ON_PEAK_SHARE * (peakW ?? 0)));
}

export class ReferenceTracker {
  private tracks = new Map<string, Track>();

  /** Feeds the current state of the devices (call about once a minute). */
  update(now: number, devices: DeviceLike[], exclude: Set<string>): void {
    for (const d of devices) {
      if (!isLoadDevice(d, exclude)) continue;
      const power = d.capabilitiesObj!.measure_power!.value as number;
      let tr = this.tracks.get(d.id);
      if (!tr) {
        tr = { name: d.name ?? d.id, heatPump: d.class === 'heatpump', cls: d.class, intervals: [], open: null, lastSeen: now };
        this.tracks.set(d.id, tr);
      }
      tr.name = d.name ?? tr.name;
      tr.heatPump = d.class === 'heatpump';
      tr.cls = d.class ?? tr.cls;
      if (tr.open && now - tr.lastSeen > REFERENCES.MAX_SILENCE_MS) this.close(tr, tr.lastSeen);
      const fade = 0.5 ** (Math.max(0, now - tr.lastSeen) / REFERENCES.PEAK_HALF_LIFE_MS);
      tr.peakW = Math.max(power, (tr.peakW ?? 0) * fade);
      const on = power > onThresholdW(tr.peakW);
      if (on && !tr.open) tr.open = { start: now, end: now };
      if (!on && tr.open) this.close(tr, now);
      if (tr.open) tr.open.end = now;
      tr.lastSeen = now;
    }
    this.prune(now);
  }

  private close(tr: Track, end: number): void {
    if (!tr.open) return;
    tr.intervals.push({ start: tr.open.start, end });
    tr.open = null;
    if (tr.intervals.length > REFERENCES.MAX_INTERVALS) tr.intervals.splice(0, tr.intervals.length - REFERENCES.MAX_INTERVALS);
  }

  private prune(now: number): void {
    const cutoff = now - REFERENCES.RETENTION_DAYS * 86_400_000;
    for (const [id, tr] of this.tracks) {
      tr.intervals = tr.intervals.filter(i => i.end >= cutoff);
      if (!tr.open && tr.intervals.length === 0 && tr.lastSeen < cutoff) this.tracks.delete(id);
    }
  }

  references(): Reference[] {
    return [...this.tracks.entries()].map(([id, tr]) => ({
      id,
      name: tr.name,
      intervals: tr.open ? [...tr.intervals, { ...tr.open }] : [...tr.intervals],
    }));
  }

  /** Homey device class by device id. */
  classes(): Map<string, string> {
    return new Map([...this.tracks.entries()].filter(([, t]) => typeof t.cls === 'string').map(([id, t]) => [id, t.cls as string]));
  }

  heatPumpIds(): string[] {
    return [...this.tracks.entries()].filter(([, t]) => t.heatPump).map(([id]) => id);
  }

  snapshot(): ReferenceSnapshot {
    return { version: 1, tracks: Object.fromEntries(this.tracks) };
  }

  static restore(snap: unknown): ReferenceTracker {
    const t = new ReferenceTracker();
    if (!snap || typeof snap !== 'object' || (snap as ReferenceSnapshot).version !== 1) return t;
    for (const [id, tr] of Object.entries((snap as ReferenceSnapshot).tracks ?? {})) {
      if (!tr || !Array.isArray(tr.intervals)) continue;
      t.tracks.set(id, {
        name: String(tr.name ?? id),
        heatPump: tr.heatPump === true,
        cls: typeof tr.cls === 'string' ? tr.cls : undefined,
        peakW: Number.isFinite(tr.peakW) ? tr.peakW : undefined,
        intervals: tr.intervals.filter(i => Number.isFinite(i?.start) && Number.isFinite(i?.end)),
        open: tr.open && Number.isFinite(tr.open.start) ? { start: tr.open.start, end: tr.open.end } : null,
        lastSeen: Number(tr.lastSeen) || 0,
      });
    }
    return t;
  }
}
