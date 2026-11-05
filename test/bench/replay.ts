/**
 * The house replayed from its raw record (src/homey/recorder.ts): the Pulse values alone go
 * through the engine, the way the app samples them (every 10 s), and what it finds is scored
 * against the devices that have their own meter. Those devices are the answer key only: nothing
 * of theirs reaches detection.
 *
 * Usage: node replay.js <dir with YYYY-MM-DD.csv> [--json out.json] [--threshold <device id>=<W>]...
 * Fetch the record first: test/bench/fetch-raw.sh <dir>.
 *
 * Scores, per device with enough runs in the window:
 *   runs   precision / recall / F1 of the device's runs against the loads matched to it (the
 *          app's own matching rules)
 *   time   share of the device's on-time the matched loads cover (recall) and share of their
 *          on-time the device was on (precision): how right "running now" would be
 *   energy matched loads' kWh over the device's kWh
 * and for the house:
 *   wrong pairs  runs longer than their load's plausible longest run (a stop paired with the
 *                wrong start)
 *   open starts  starts waiting for a stop, sampled each minute (mean and max)
 */
import * as fs from 'fs';
import * as path from 'path';
import { PowerEngine } from '../../src/engine/engine';
import { Reference, matchReferences } from '../../src/engine/labels';
import { Interval, Score, intervalsFromPower } from '../../src/engine/score';
import { Activation, LoadCluster, activationKWh } from '../../src/engine/types';
import { Latest, readingFrom } from '../../src/homey/meter';

const SAMPLE_MS = 10_000;
const CAP: Record<string, string> = {
  P: 'measure_power',
  I1: 'measure_current.L1',
  I2: 'measure_current.L2',
  I3: 'measure_current.L3',
  U1: 'measure_voltage.L1',
  U2: 'measure_voltage.L2',
  U3: 'measure_voltage.L3',
};
/** The app's matching (src/homey/analysis.ts, direct matches). */
const MATCH = { tolMs: 6 * 60_000, gapMs: 2 * 60_000, maxDurationRatio: 3, alpha: 0.02 };
/** A device's power readings this far apart leave it unknown in between. */
const DEVICE_MAX_GAP_MS = 6 * 3_600_000;
const MIN_DEVICE_RUNS = 3;

const args = process.argv.slice(2);
const dir = args[0] ?? 'bench-data/raw';
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const thresholds = new Map<string, number>();
args.forEach((a, i) => {
  if (a !== '--threshold') return;
  const [id, w] = (args[i + 1] ?? '').split('=');
  if (id && Number.isFinite(Number(w))) thresholds.set(id, Number(w));
});

// ---- read the record -----------------------------------------------------------------------

interface Event {
  t: number;
  key: string;
  v: number;
}
const events: Event[] = [];
const names = new Map<string, string>();
const files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort();
if (!files.length) throw new Error(`No YYYY-MM-DD.csv files in ${dir}`);
for (const f of files) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line) continue;
    if (line.startsWith('#name,')) {
      const [, id, ...name] = line.split(',');
      names.set(id, name.join(','));
      continue;
    }
    const [t, key, v] = line.split(',');
    const e = { t: Number(t), key, v: Number(v) };
    if (Number.isFinite(e.t) && Number.isFinite(e.v)) events.push(e);
  }
}
events.sort((a, b) => a.t - b.t);
const meterEvents = events.filter(e => e.key in CAP);
const deviceSeries = new Map<string, Array<{ t: number; v: number }>>();
for (const e of events) {
  if (e.key in CAP) continue;
  const s = deviceSeries.get(e.key) ?? [];
  s.push({ t: e.t, v: e.v });
  deviceSeries.set(e.key, s);
}
const from = meterEvents[0].t;
const to = meterEvents[meterEvents.length - 1].t;
const days = (to - from) / 86_400_000;

// ---- replay the Pulse ----------------------------------------------------------------------

const engine = new PowerEngine('Europe/Stockholm');
const latest = new Map<string, Latest>();
let k = 0;
let houseKWh = 0;
let lastTotal: { t: number; w: number } | null = null;
const openCounts: number[] = [];
for (let tick = Math.ceil(from / SAMPLE_MS) * SAMPLE_MS; tick <= to; tick += SAMPLE_MS) {
  for (; k < meterEvents.length && meterEvents[k].t <= tick; k++) {
    latest.set(CAP[meterEvents[k].key], { value: meterEvents[k].v, at: meterEvents[k].t });
  }
  const r = readingFrom(latest, tick);
  if (!r) continue;
  engine.push(r);
  const total = r.total as number;
  if (lastTotal && tick - lastTotal.t <= 120_000) houseKWh += (lastTotal.w * (tick - lastTotal.t)) / 3.6e9;
  lastTotal = { t: tick, w: total };
  if (tick % 60_000 === 0) openCounts.push(engine.running().length);
}

const loads = engine.loads();
const clustered = loads.flatMap(c => c.activations.map(a => ({ a, c })));
const wrong = clustered.filter(({ a, c }) => a.end - a.start > c.maxMinutes * 60_000);

// ---- the answer key ------------------------------------------------------------------------

const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] : 0;
};
/** Energy of a device from its readings, each held until the next (kWh). */
const deviceKWh = (s: Array<{ t: number; v: number }>, lo: number, hi: number) => {
  let kWh = 0;
  for (let i = 0; i < s.length; i++) {
    const a = Math.max(lo, s[i].t);
    const b = Math.min(hi, s[i + 1]?.t ?? hi);
    if (b > a && b - a <= DEVICE_MAX_GAP_MS && s[i].v > 0) kWh += (s[i].v * (b - a)) / 3.6e9;
  }
  return kWh;
};
const refs: Array<Reference & { thresholdW: number; kWh: number }> = [];
for (const [id, s] of deviceSeries) {
  const on = s.filter(x => x.v > 5).map(x => x.v);
  if (!on.length) continue;
  // On when above a share of its high power: a spa's circulation pump or a charger's standby is not
  // the load the Pulse can see.
  const thresholdW = thresholds.get(id) ?? Math.min(400, Math.max(30, 0.2 * p95(on)));
  // A held value lasts until the next one: the device's last reading holds to the end of the window.
  const intervals = intervalsFromPower([...s, { t: to, v: s[s.length - 1].v }], thresholdW, DEVICE_MAX_GAP_MS).filter(
    i => i.end > from && i.start < to
  );
  if (intervals.length < MIN_DEVICE_RUNS) continue;
  refs.push({ id, name: names.get(id) ?? id, intervals, thresholdW, kWh: deviceKWh(s, from, to) });
}

// ---- scores --------------------------------------------------------------------------------

/** Total length of the union of intervals (ms). */
const unionMs = (xs: Interval[]) => {
  let total = 0;
  let cur: Interval | null = null;
  for (const x of [...xs].sort((a, b) => a.start - b.start)) {
    if (cur && x.start <= cur.end) cur.end = Math.max(cur.end, x.end);
    else {
      if (cur) total += cur.end - cur.start;
      cur = { ...x };
    }
  }
  return total + (cur ? cur.end - cur.start : 0);
};
const intersectMs = (a: Interval[], b: Interval[]) => {
  const out: Interval[] = [];
  for (const x of a) for (const y of b) {
    const s = Math.max(x.start, y.start);
    const e = Math.min(x.end, y.end);
    if (e > s) out.push({ start: s, end: e });
  }
  return unionMs(out);
};
/** A missed stop counts at the load's typical length, as the app's ledger does. */
const typicalKWh = (a: Activation, c: LoadCluster) =>
  a.end - a.start > c.maxMinutes * 60_000 ? activationKWh({ ...a, end: a.start + c.medianMinutes * 60_000 }) : activationKWh(a);

const matches = matchReferences(loads, refs, MATCH);
interface DeviceScore {
  id: string;
  name: string;
  runs: number;
  thresholdW: number;
  loads: string[];
  run: Score | null;
  timeRecall: number;
  timePrecision: number;
  energyRatio: number | null;
}
const devices: DeviceScore[] = refs.map(r => {
  const m = matches.find(x => x.referenceId === r.id);
  const cs = loads.filter(c => m?.clusterIds.includes(c.id));
  const acts = cs.flatMap(c => c.activations.map(a => ({ start: a.start, end: Math.min(a.end, a.start + c.maxMinutes * 60_000) })));
  const on = unionMs(r.intervals);
  const found = unionMs(acts);
  const both = intersectMs(r.intervals, acts);
  const kWh = cs.reduce((s, c) => s + c.activations.reduce((x, a) => x + typicalKWh(a, c), 0), 0);
  return {
    id: r.id,
    name: r.name,
    runs: r.intervals.length,
    thresholdW: Math.round(r.thresholdW),
    loads: cs.map(c => c.id),
    run: m?.score ?? null,
    timeRecall: on ? both / on : 0,
    timePrecision: found ? both / found : 0,
    energyRatio: r.kWh > 0 ? kWh / r.kWh : null,
  };
});

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const result = {
  window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), days: Math.round(days * 100) / 100 },
  readings: meterEvents.length,
  houseKWhPerDay: houseKWh / days,
  activations: engine.allActivations().length,
  loads: loads.length,
  wrongPairs: { count: wrong.length, share: clustered.length ? wrong.length / clustered.length : 0 },
  openStarts: { mean: mean(openCounts), max: Math.max(0, ...openCounts) },
  devices,
};

const pct = (x: number | null) => (x === null ? '   -' : `${Math.round(x * 100)}%`.padStart(4));
console.log(`window ${result.window.from} .. ${result.window.to} (${result.window.days} days), ${result.readings} meter values`);
console.log(`house ${result.houseKWhPerDay.toFixed(1)} kWh/day, ${result.activations} runs in ${result.loads} loads`);
console.log(`wrong pairs ${wrong.length} (${pct(result.wrongPairs.share).trim()}), open starts mean ${result.openStarts.mean.toFixed(1)} max ${result.openStarts.max}`);
console.log('device                         runs  >W     run P/R/F1      time R/P   energy  loads');
for (const d of devices) {
  const run = d.run ? `${pct(d.run.precision)} ${pct(d.run.recall)} ${pct(d.run.f1)}` : '   -    -    -';
  console.log(
    `${d.name.slice(0, 30).padEnd(30)} ${String(d.runs).padStart(5)} ${String(d.thresholdW).padStart(4)}  ${run}   ${pct(d.timeRecall)} ${pct(d.timePrecision)}   ${pct(d.energyRatio)}   ${d.loads.join(' ')}`
  );
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 1));
