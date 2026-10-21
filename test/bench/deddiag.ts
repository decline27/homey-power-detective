/**
 * Benchmark on DEDDIAG house 8 (Wenninger et al., Scientific Data 2021): 325 days of three-phase
 * mains at 1 Hz from a German home, resampled to 10 s snapshots like a Swedish HAN meter, with
 * a plug-metered, hand-annotated dishwasher and washing machine as the judge.
 *
 * Protocol (no peeking): the days are split into alternating 14-day blocks. Loads, their names
 * and their run profiles are learned on the even blocks only; the odd blocks are classified with
 * those frozen loads and scored against the annotated runs.
 * Usage: node deddiag.js <bench dir with h8_t.f64, h8_p.f32, h8_gt.json>
 */
import * as fs from 'fs';
import * as path from 'path';
import { classify, clusterActivations } from '../../src/engine/clustering';
import { decompose } from '../../src/engine/decompose';
import { StepDetector } from '../../src/engine/detector';
import { matchReferences, Reference } from '../../src/engine/labels';
import { Pairer } from '../../src/engine/pairer';
import { learnRunFilter, passes, runsOf } from '../../src/engine/profile';
import { matchIntervals, sessions } from '../../src/engine/score';
import { Activation } from '../../src/engine/types';

const dir = process.argv[2] ?? 'bench-data/deddiag';
const tBuf = fs.readFileSync(path.join(dir, 'h8_t.f64'));
const pBuf = fs.readFileSync(path.join(dir, 'h8_p.f32'));
const T = new Float64Array(tBuf.buffer, tBuf.byteOffset, tBuf.byteLength / 8);
const Pw = new Float32Array(pBuf.buffer, pBuf.byteOffset, pBuf.byteLength / 4);
const gt = JSON.parse(fs.readFileSync(path.join(dir, 'h8_gt.json'), 'utf8'));

const detector = new StepDetector();
const pairer = new Pairer();
const acts: Activation[] = [];
const t0 = Date.now();
for (let i = 0; i < T.length; i++) {
  const w: [number, number, number] = [Pw[3 * i], Pw[3 * i + 1], Pw[3 * i + 2]];
  const t = T[i] * 1000;
  for (const change of detector.push({ t, w })) {
    for (const step of decompose(change, pairer.running())) {
      const a = pairer.push(step);
      if (a) acts.push(a);
    }
  }
}
const ms = Date.now() - t0;
const start = T[0] * 1000;
const end = T[T.length - 1] * 1000;
const BLOCK = 14 * 86_400_000;
// Fold 0 learns on even blocks, fold 1 on odd blocks: both must hold up.
const fold = process.argv.includes('fold1') ? 1 : 0;
const isTrain = (t: number) => Math.floor((t - start) / BLOCK) % 2 === fold;
console.log(`readings ${T.length} (${((end - start) / 86_400_000).toFixed(0)} days) in ${(ms / 1000).toFixed(1)} s = ${((ms / T.length) * 1000).toFixed(1)} µs/reading; activations ${acts.length}`);

const train = acts.filter(a => isTrain(a.start));
const test = acts.filter(a => !isTrain(a.start));
const loads = clusterActivations(train, { from: start, to: start + (end - start) / 2 });
console.log(`learned ${loads.length} loads on the training blocks; largest by energy:`);
for (const c of loads.slice(0, 8)) {
  console.log(`  ${c.id.padEnd(14)} ${c.phases.padEnd(8)} ${Math.round(c.medianW).toString().padStart(5)} W ${c.medianMinutes.toFixed(1).padStart(6)} min n=${c.count} ${c.kWhPerDay.toFixed(2)} kWh/day${c.rhythmic ? ' RHYTHMIC' : ''}`);
}

// Runs during which the mains meter was mostly silent cannot be seen by any method; they are
// left out of the judge (and counted, so it is visible).
function mainsCoverage(fromS: number, toS: number): number {
  let lo = 0;
  let hi = T.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (T[mid] < fromS) lo = mid + 1;
    else hi = mid;
  }
  let n = 0;
  let ok = 0;
  for (let i = lo; i < T.length && T[i] <= toS; i++) {
    n++;
    if (!Number.isNaN(Pw[3 * i]) && !Number.isNaN(Pw[3 * i + 1]) && !Number.isNaN(Pw[3 * i + 2])) ok++;
  }
  const expected = Math.max(1, (toS - fromS) / 10);
  return Math.min(n, ok) / expected;
}
const excluded: Record<string, number> = {};
const ref = (name: string, train: boolean): Reference => ({
  id: name,
  name,
  intervals: (gt.appliances[name] as Array<{ start: number; end: number }>)
    .filter(x => {
      const seen = mainsCoverage(x.start, x.end) >= 0.8;
      if (!seen && !train) excluded[name] = (excluded[name] ?? 0) + 1;
      return seen;
    })
    .map(x => ({ start: x.start * 1000, end: x.end * 1000 }))
    .filter(x => isTrain(x.start) === train),
});
const opts = { tolMs: 10 * 60_000, gapMs: 45 * 60_000, maxDurationRatio: Infinity, minPrecision: 0.6, minF1: 0.3 };
// Judge: the plug meters (every run they saw); the hand annotations are a second, sparser judge.
const judges = process.argv.includes('annotations') ? ['dishwasher', 'washing_machine'] : ['dishwasher_plug', 'washing_machine_plug'];
console.log(`judge: ${process.argv.includes('annotations') ? 'hand annotations' : 'plug meters'}, fold ${fold}`);
const named = matchReferences(loads, judges.map(n => ref(n, true)), opts);
const overlaps = (r: { start: number; end: number }, refs: Array<{ start: number; end: number }>) =>
  refs.some(x => r.start <= x.end + opts.tolMs && r.end >= x.start - opts.tolMs);

let pass = true;
for (const name of judges) {
  const m = named.find(x => x.referenceId === name);
  if (!m) {
    console.log(`${name}: not recognised on the first half`);
    pass = false;
    continue;
  }
  const mine = loads.filter(c => m.clusterIds.includes(c.id));
  // Run profile from the training runs the reference confirmed.
  const trainRef = ref(name, true).intervals;
  const trainRuns = runsOf(mine.flatMap(c => c.activations), opts.gapMs);
  const filter = learnRunFilter(trainRuns, trainRuns.map(r => overlaps(r, trainRef)));
  const testActs = test.filter(a => {
    const c = classify(a, loads);
    return c !== null && m.clusterIds.includes(c.id);
  });
  const testRuns = runsOf(testActs, opts.gapMs);
  const kept = filter ? testRuns.filter(r => passes(filter, r)) : testRuns;
  const r = ref(name, false);
  const s0 = matchIntervals(sessions(r.intervals, opts.gapMs), testRuns, opts.tolMs, Infinity);
  const s = matchIntervals(sessions(r.intervals, opts.gapMs), kept, opts.tolMs, Infinity);
  const plug = (gt.appliances[name] as Array<{ start: number; end: number; kWh: number }>)
    .filter(x => !isTrain(x.start * 1000) && mainsCoverage(x.start, x.end) >= 0.8)
    .reduce((q, x) => q + x.kWh, 0);
  const found = kept.reduce((q, x) => q + x.kWh, 0);
  console.log(`   loads only: P=${s0.precision.toFixed(2)} R=${s0.recall.toFixed(2)} F1=${s0.f1.toFixed(2)}; run filter ${filter ? `>= ${filter.minCount} steps, >= ${filter.minSpanMinutes.toFixed(0)} min, >= ${filter.minKWh.toFixed(2)} kWh (train F1 ${filter.trainF1.toFixed(2)})` : 'none'}`);
  console.log(
    `${name}: learned as ${mine.map(c => `${c.phases} ${Math.round(c.medianW)} W`).join(' + ')} (train F1 ${m.score.f1.toFixed(2)})` +
      `\n   HELD-OUT runs (${r.intervals.length} seen, ${excluded[name] ?? 0} during mains gaps left out): P=${s.precision.toFixed(2)} R=${s.recall.toFixed(2)} F1=${s.f1.toFixed(2)} (tp ${s.tp} fp ${s.fp} fn ${s.fn}); energy found ${found.toFixed(1)} kWh vs plug ${plug.toFixed(1)} kWh (${((found / plug) * 100).toFixed(0)} %)`
  );
  if (s.f1 < 0.9) pass = false;
}
console.log(pass ? 'PASS (held-out F1 >= 0.90 for both)' : 'FAIL against the target (held-out F1 >= 0.90 for both)');
