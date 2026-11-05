/** The raw recorder: one file per local day, values as they came, old days removed. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { RawRecorder } from '../../src/homey/recorder';

const TZ = 'Europe/Stockholm';
const at = (iso: string) => Date.parse(iso);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pd-raw-'));
const lines = (dir: string, date: string) => fs.readFileSync(path.join(dir, `${date}.csv`), 'utf8').trim().split('\n');

test('meter and device values are written as they came, a device with its name once', () => {
  const dir = tmpDir();
  const r = new RawRecorder(dir, TZ);
  const t = at('2026-11-05T08:00:00Z');
  r.meter(t, 'measure_power', 3411);
  r.meter(t + 10, 'measure_current.L1', 9.5);
  r.meter(t + 20, 'meter_power', 16.25); // not a value detection uses
  r.device(t + 30, 'spa', 'BWA Spa, outdoor', 2800);
  r.device(t + 60_030, 'spa', 'BWA Spa, outdoor', 2800); // polled again, unchanged
  r.device(t + 120_030, 'spa', 'BWA Spa, outdoor', 0);
  r.flush();
  expect(lines(dir, '2026-11-05')).toEqual([
    `${t},P,3411`,
    `${t + 10},I1,9.5`,
    '#name,spa,BWA Spa  outdoor',
    `${t + 30},spa,2800`,
    `${t + 120_030},spa,0`,
  ]);
});

test('a new local day starts a new file that stands alone; days past the kept ones are removed', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '2026-10-01.csv'), 'old\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a day\n');
  const r = new RawRecorder(dir, TZ, 8);
  // 23:59 and 00:01 local time (UTC+1 in November).
  r.device(at('2026-11-04T22:59:00Z'), 'hp', 'Heatpump', 900);
  r.device(at('2026-11-04T23:01:00Z'), 'hp', 'Heatpump', 900);
  r.flush();
  expect(lines(dir, '2026-11-04')).toEqual(['#name,hp,Heatpump', `${at('2026-11-04T22:59:00Z')},hp,900`]);
  expect(lines(dir, '2026-11-05')).toEqual(['#name,hp,Heatpump', `${at('2026-11-04T23:01:00Z')},hp,900`]);
  expect(r.days().map(d => d.date)).toEqual(['2026-11-04', '2026-11-05']);
  expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
});

test('a day is read back gzipped, with what is still buffered; a bad date reads nothing', () => {
  const dir = tmpDir();
  const r = new RawRecorder(dir, TZ);
  const t = at('2026-11-05T08:00:00Z');
  r.meter(t, 'measure_power', 500);
  const day = r.read('2026-11-05');
  expect(zlib.gunzipSync(Buffer.from(day!.gzip, 'base64')).toString()).toBe(`${t},P,500\n`);
  expect(r.read('../state')).toBeNull();
  expect(r.read('2026-01-01')).toBeNull();
});
