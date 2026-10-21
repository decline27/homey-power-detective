/**
 * Benchmark on Kjetil's own house: 6 h of Homey Insights minute data from the Tibber Pulse
 * (current per phase, total power). Judge: the heat pump's runs as MELCloud reports them
 * (independent of the Pulse), plus the Balboa spa and the Easee charger.
 * Usage: node homey-day.js <dir with pulse_L1.json ...>
 */
import * as fs from 'fs';
import * as path from 'path';
import { PowerEngine } from '../../src/engine/engine';
import { matchReferences, Reference } from '../../src/engine/labels';
import { intervalsFromPower, matchIntervals, sessions, asIntervals } from '../../src/engine/score';

const dir = process.argv[2] ?? 'bench-data/homey';
const load = (f: string) =>
  (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).entries as Array<{ t: string; v: number | null }>).map(e => ({ t: Date.parse(e.t), v: e.v }));
const L = ['pulse_L1.json', 'pulse_L2.json', 'pulse_L3.json'].map(load);
const P = load('pulse_power.json');
const V = 230;

const engine = new PowerEngine('Europe/Stockholm');
for (let i = 0; i < L[0].length; i++) {
  const t = L[0][i].t;
  const w = L.map(s => (s[i]?.v ?? NaN) * V) as [number, number, number];
  engine.push({ t, w, total: P.find(p => p.t === t)?.v ?? undefined });
}
const loads = engine.loads();
console.log(`window ${new Date(L[0][0].t).toISOString()} .. ${new Date(L[0][L[0].length - 1].t).toISOString()}`);
console.log(`activations ${engine.allActivations().length}, loads ${loads.length}`);
for (const c of loads) {
  console.log(
    `${c.id.padEnd(14)} ${c.phases.padEnd(8)} ${Math.round(c.medianW).toString().padStart(5)} W  ` +
      `${c.medianMinutes.toFixed(1).padStart(5)} min  n=${c.count}  ${c.startsPerDay.toFixed(0)}/day  ` +
      `${c.kWhPerDay.toFixed(1)} kWh/day  period ${c.periodMinutes?.toFixed(0) ?? '-'} min cv ${c.periodCv?.toFixed(2) ?? '-'}${c.rhythmic ? '  RHYTHMIC' : ''}`
  );
}
const refs: Reference[] = [
  { id: 'heatpump', name: 'Heat pump (MELCloud)', intervals: intervalsFromPower(load('heatpump_power.json'), 50, 5 * 60_000) },
  { id: 'spa', name: 'Spa (Balboa)', intervals: intervalsFromPower(load('spa_power.json'), 500, 5 * 60_000) },
  { id: 'easee', name: 'EV charger (Easee)', intervals: intervalsFromPower(load('easee_power.json'), 500, 5 * 60_000) },
];
for (const r of refs) console.log(`reference ${r.id}: ${r.intervals.length} runs`);
const matches = matchReferences(loads, refs, { tolMs: 6 * 60_000, gapMs: 60_000 });
for (const m of matches) {
  console.log(`MATCH ${m.referenceName} <- ${m.clusterIds.join(', ')}  P=${m.score.precision.toFixed(2)} R=${m.score.recall.toFixed(2)} F1=${m.score.f1.toFixed(2)} (tp ${m.score.tp} fp ${m.score.fp} fn ${m.score.fn})`);
}
// Heat pump judged directly: every 3-phase activation vs MELCloud runs.
const hp = refs[0];
const threePhase = loads.filter(c => c.phases === '3-phase').flatMap(c => c.activations);
const s = matchIntervals(sessions(hp.intervals, 60_000), sessions(asIntervals(threePhase), 60_000), 6 * 60_000);
console.log(`HEATPUMP (all 3-phase loads) P=${s.precision.toFixed(2)} R=${s.recall.toFixed(2)} F1=${s.f1.toFixed(2)} tp ${s.tp} fp ${s.fp} fn ${s.fn}`);
