/**
 * The raw recorder: every value the house meter and the metered devices report, as it came, for
 * the last RECORDER.KEEP_DAYS days. The engine keeps only the runs it found; this keeps what it
 * found them in, so a change to detection can be replayed on the house's own week and scored
 * against the devices that have their own meter (test/bench/replay.ts).
 *
 * One file per local day, one line per value: `t,key,value`. Keys: P (house total, W), I1..I3
 * (current, A), U1..U3 (voltage, V), or a device id (its measure_power, W). A device's name is
 * written once per file before its first value: `#name,id,name`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { localDate } from '../engine/day-meter';

export const RECORDER = {
  /** Days kept, today included. */
  KEEP_DAYS: 8,
  /** Lines held in memory before they are written anyway (a stalled flush timer must not grow memory). */
  MAX_BUFFER: 5_000,
};

const METER_KEYS: Record<string, string> = {
  measure_power: 'P',
  'measure_current.L1': 'I1',
  'measure_current.L2': 'I2',
  'measure_current.L3': 'I3',
  'measure_voltage.L1': 'U1',
  'measure_voltage.L2': 'U2',
  'measure_voltage.L3': 'U3',
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class RawRecorder {
  private lines: string[] = [];
  private date: string | null = null;
  /** Devices whose name is in the current file. */
  private named = new Set<string>();
  /** Last value written per device: a device polled each minute is written when it changes. */
  private lastDevice = new Map<string, number>();

  constructor(private readonly dir: string, private readonly timeZone: string, private readonly keepDays = RECORDER.KEEP_DAYS) {}

  /** A value from the house meter, by capability id. */
  meter(t: number, cap: string, value: number): void {
    const key = METER_KEYS[cap];
    if (key && Number.isFinite(value)) this.add(t, `${t},${key},${value}`);
  }

  /** A metered device's power (W). */
  device(t: number, id: string, name: string, value: number): void {
    if (!Number.isFinite(value) || this.lastDevice.get(id) === value) return;
    this.lastDevice.set(id, value);
    this.roll(t);
    if (!this.named.has(id)) {
      this.named.add(id);
      this.lines.push(`#name,${id},${name.replace(/[,\n\r]/g, ' ')}`);
    }
    this.add(t, `${t},${id},${value}`);
  }

  private add(t: number, line: string): void {
    this.roll(t);
    this.lines.push(line);
    if (this.lines.length >= RECORDER.MAX_BUFFER) this.flush();
  }

  /** A new day starts a new file: what is buffered goes to the old one first. */
  private roll(t: number): void {
    const date = localDate(t, this.timeZone);
    if (date === this.date) return;
    this.flush();
    this.date = date;
    this.named.clear();
    // Each file stands alone: the next value of every device is written, with its name.
    this.lastDevice.clear();
    this.prune(localDate(t - (this.keepDays - 1) * 86_400_000, this.timeZone));
  }

  /** Appends what is buffered to today's file. */
  flush(): void {
    if (!this.lines.length || !this.date) return;
    const text = this.lines.join('\n') + '\n';
    this.lines = [];
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(path.join(this.dir, `${this.date}.csv`), text);
  }

  /** Removes the files of days before `oldest` ('YYYY-MM-DD'). */
  private prune(oldest: string): void {
    for (const d of this.days()) if (d.date < oldest) fs.rmSync(path.join(this.dir, `${d.date}.csv`), { force: true });
  }

  /** The days on file, oldest first, with their size (bytes). */
  days(): Array<{ date: string; bytes: number }> {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter(n => n.endsWith('.csv') && DATE.test(n.slice(0, -4)))
      .sort()
      .map(n => ({ date: n.slice(0, -4), bytes: fs.statSync(path.join(this.dir, n)).size }));
  }

  /** One day's file, gzipped and base64-encoded (a day is about a megabyte of text). */
  read(date: string): { date: string; gzip: string } | null {
    if (!DATE.test(date)) return null;
    if (date === this.date) this.flush();
    try {
      return { date, gzip: zlib.gzipSync(fs.readFileSync(path.join(this.dir, `${date}.csv`))).toString('base64') };
    } catch {
      return null;
    }
  }
}
