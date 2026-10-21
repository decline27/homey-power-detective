/**
 * Devices that measure themselves (an EV charger, the heat pump through MELCloud, smart plugs):
 * when each was on, kept as intervals. They name the loads that coincide with them and judge,
 * live, how well the engine finds them from the house meter alone.
 */
import { Reference } from '../engine/labels';
import { Interval } from '../engine/score';
import { DeviceLike } from './meter';

export const REFERENCES = {
  /** A device counts as on above this (W). */
  ON_W: 50,
  /** Intervals kept per device, and days. */
  MAX_INTERVALS: 3000,
  RETENTION_DAYS: 21,
  /** Without a new reading for this long, an open interval is closed at the last reading (ms). */
  MAX_SILENCE_MS: 15 * 60_000,
};

interface Track {
  name: string;
  heatPump: boolean;
  intervals: Interval[];
  open: Interval | null;
  lastSeen: number;
}

export interface ReferenceSnapshot {
  version: 1;
  tracks: Record<string, Track>;
}

export class ReferenceTracker {
  private tracks = new Map<string, Track>();

  /** Feeds the current state of the devices (call about once a minute). */
  update(now: number, devices: DeviceLike[], exclude: Set<string>): void {
    for (const d of devices) {
      if (exclude.has(d.id)) continue;
      const power = d.capabilitiesObj?.measure_power?.value;
      if (!Array.isArray(d.capabilities) || !d.capabilities.includes('measure_power') || typeof power !== 'number') continue;
      // Other whole-house meters are not loads.
      if (d.energyObj?.cumulative === true || d.capabilities.includes('meter_power.imported')) continue;
      let tr = this.tracks.get(d.id);
      if (!tr) {
        tr = { name: d.name ?? d.id, heatPump: d.class === 'heatpump', intervals: [], open: null, lastSeen: now };
        this.tracks.set(d.id, tr);
      }
      tr.name = d.name ?? tr.name;
      tr.heatPump = d.class === 'heatpump';
      if (tr.open && now - tr.lastSeen > REFERENCES.MAX_SILENCE_MS) this.close(tr, tr.lastSeen);
      const on = power > REFERENCES.ON_W;
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
        intervals: tr.intervals.filter(i => Number.isFinite(i?.start) && Number.isFinite(i?.end)),
        open: tr.open && Number.isFinite(tr.open.start) ? { start: tr.open.start, end: tr.open.end } : null,
        lastSeen: Number(tr.lastSeen) || 0,
      });
    }
    return t;
  }
}
