/// <reference lib="dom" />
/**
 * System test of the two pages a user sees, in a real browser, wired to the real app:
 *
 *   Chromium page ── Homey.api / get / set ──> exposed functions ──> api.ts, widget api.js,
 *                                                                    homey.settings ──> app
 *
 * The simulated house runs first, so the pages show found loads, not fixtures. What the user
 * does on a page (name a load, start a test, save settings, ask for a summary) is checked where
 * it lands: in the app and its settings.
 *
 * Needs Chromium: PD_CHROMIUM, /opt/pw-browsers/chromium or Playwright's own; skipped without.
 */
jest.mock('homey-api', () => require('./harness').homeyApiMock);

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Browser, Page } from 'playwright-core';
import { FakeHomey, HOUR, MIN, Sim, boot, referenceHouse, standardDevices } from './harness';

const ROOT = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pages-'));
process.env.POWER_DETECTIVE_STATE = path.join(tmp, 'state.json');
const api = require('../../api');
const widgetApi = require('../../widgets/now/api.js');
const { chromium } = require('playwright-core');

function findChromium(): string | null {
  const candidates = [process.env.PD_CHROMIUM, '/opt/pw-browsers/chromium'];
  try {
    candidates.push(chromium.executablePath());
  } catch {
    /* no bundled browser */
  }
  return candidates.find(p => !!p && fs.existsSync(p)) ?? null;
}
const CHROMIUM = findChromium();
const maybe = CHROMIUM ? test : test.skip;

/** The page side of Homey: Homey.api/get/set call into the test process. */
const HOMEY_JS = `
  const Homey = {
    api(method, path, body, cb) {
      const p = window.__homeyApi(method, path, body ?? null);
      if (cb) { p.then(v => cb(null, v), e => cb(e)); return undefined; }
      return p;
    },
    get(key, cb) { window.__homeyGet(key).then(v => cb(null, v)); },
    set(key, value, cb) { window.__homeySet(key, value).then(() => cb && cb(null)); },
    ready() { window.__homeyReady = true; },
  };
  window.addEventListener('load', () => onHomeyReady(Homey));
`;

const homey = new FakeHomey();
const house = referenceHouse();
const sim = new Sim(house, homey);
let app: any;
let browser: Browser;
let floorId: string;

const ROUTES: Record<string, (body: any) => Promise<unknown>> = {
  'GET /state': () => api.getState({ homey }),
  'GET /meters': () => api.getMeters({ homey }),
  'POST /name': body => api.setName({ homey, body }),
  'POST /test': body => api.startTest({ homey, body }),
  'POST /summary': () => api.writeSummary({ homey }),
  'GET /now': () => widgetApi.getNow({ homey }),
};

async function open(file: string, opts: { width?: number; height?: number; dark?: boolean } = {}) {
  const page = await browser.newPage({ viewport: { width: opts.width ?? 420, height: opts.height ?? 900 }, colorScheme: opts.dark ? 'dark' : 'light' });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await page.clock.setFixedTime(homey.now);
  await page.exposeFunction('__homeyApi', async (method: string, p: string, body: unknown) => {
    const route = ROUTES[`${method} ${p}`];
    if (!route) throw new Error(`No route ${method} ${p}`);
    return JSON.parse(JSON.stringify(await route(body)));
  });
  await page.exposeFunction('__homeyGet', async (k: string) => homey.settings.get(k));
  await page.exposeFunction('__homeySet', async (k: string, v: unknown) => homey.settings.set(k, v));
  await page.route('**/homey.js', r => r.fulfill({ contentType: 'text/javascript', body: HOMEY_JS }));
  await page.goto(`file://${path.join(ROOT, file)}`);
  await page.waitForFunction(() => (window as any).__homeyReady === true);
  return { page, errors };
}

const text = (page: Page, sel: string) => page.locator(sel).innerText();
/** Text of a part behind a closed <details>: not rendered, so it has no innerText. */
const content = async (page: Page, sel: string) => (await page.locator(sel).textContent()) ?? '';

beforeAll(async () => {
  standardDevices();
  jest.spyOn(Date, 'now').mockImplementation(() => homey.now);
  if (!CHROMIUM) return;
  browser = await chromium.launch({ executablePath: CHROMIUM });
  app = await boot(homey);
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await app?.onUninit();
  jest.restoreAllMocks();
});

maybe('widget before any data: says it is learning, no errors', async () => {
  await sim.advance(5 * MIN);
  const { page, errors } = await open('widgets/now/public/index.html', { width: 360, height: 360 });
  await page.waitForSelector('#rows .empty');
  expect(await text(page, '#rows')).toMatch(/Learning your house/);
  expect(await text(page, '#total')).toMatch(/^\d[\d,]* ?W$/);
  expect(errors).toEqual([]);
  await page.close();
}, 60_000);

maybe('settings page: shows what was found, and every action lands in the app', async () => {
  await sim.advance(30 * HOUR);
  const floor = (await api.getState({ homey })).loads.find((l: any) => l.phases === 'L1' && Math.abs(l.medianW - 1330) < 80);
  floorId = floor.id;
  // Opened while the floor heater runs, so it shows under "On now".
  await sim.until(() => house.isOn('floor', homey.now), 70 * MIN);
  await sim.advance(2 * MIN);

  const { page, errors } = await open('settings/index.html', { width: 380 });
  await page.waitForFunction(() => document.getElementById('k-kwh')!.textContent !== '–');
  expect(await text(page, '#status')).toMatch(/^Listening to Pulse · 1\.\d days observed$/);
  // The answer first: what the house uses a day and costs a month.
  expect(await text(page, '#k-kwh')).toMatch(/^\d+(\.\d)?$/);
  expect(await text(page, '#k-cost')).toMatch(/^\d[\d,]* SEK$/);
  expect(await page.locator('#chart svg rect').count()).toBeGreaterThan(3);
  // The floor heater is unknown and unmeasured: it is asked about, in words.
  expect(await text(page, '#loads')).toMatch(/every 6\d min for 2\d min, day and night/);
  // The heat pump is measured: not asked about, listed with the rest.
  expect(await text(page, '#loads')).not.toContain('Värmepump');
  expect(await content(page, '#allloads')).toMatch(/measured by Värmepump/);
  expect(await content(page, '#validation')).toContain('Värmepump');
  // Where the energy goes names the metered heat pump; the device table (under Details) says
  // what was learned about it (MELCloud reports minutes late: counted by energy, not subtracted).
  expect(await text(page, '#where')).toContain('Värmepump');
  expect(await content(page, '#metered')).toMatch(/Värmepump[\s\S]*by its energy/);
  expect(await content(page, '#metered')).toMatch(/3[\s\S]*min late/);
  expect(await page.locator('#meter option').count()).toBe(2);
  // Short: what is not the answer waits behind a click.
  expect(await page.locator('#details').evaluate(d => (d as HTMLDetailsElement).open)).toBe(false);
  expect(await page.locator('#settings').evaluate(d => (d as HTMLDetailsElement).open)).toBe(false);
  // Fits a phone: nothing wider than the screen.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);

  // On now: what the house draws, the floor heater by size while it has no name; named on the spot.
  expect(await text(page, '#now')).toMatch(/The house draws [\d.,]+ kW/);
  expect(await text(page, '#now')).toMatch(/Unknown load on L1\s+usually about 1\.3 kW, since \d\d:\d\d\s+1\.3 kW\s+What is it\?/);
  await page.click(`#now button[data-nameit="${floorId}"]`);
  expect(await text(page, '#nf-title')).toMatch(/^Unknown load on L1, on since \d\d:\d\d$/);
  await page.fill('#nf-name', 'Floor');
  await page.click('#nf-save');
  await page.waitForFunction(() => /Floor\s+since/.test(document.getElementById('now')!.innerText));
  expect((homey.settings.get('load_names') as Record<string, string>)[floorId]).toBe('Floor');
  expect(await page.locator('#nameform').isHidden()).toBe(true);
  expect(await page.locator(`#now button[data-nameit="${floorId}"]`).count()).toBe(0);
  // Named, it left the loads to name; renamed in the full list, saved on change.
  expect(await text(page, '#loads')).not.toMatch(/every 6\d min for 2\d min/);
  await page.click('#all-title');
  await page.locator(`#allloads input[data-name="${floorId}"]`).fill('Kitchen floor');
  await page.locator(`#allloads input[data-name="${floorId}"]`).press('Tab');
  await page.waitForFunction(() => document.getElementById('allloads')!.textContent!.includes('Kitchen floor'));
  expect((homey.settings.get('load_names') as Record<string, string>)[floorId]).toBe('Kitchen floor');

  // Start a test from the load's button: the form on the page (Homey shows no browser dialogs).
  await page.locator(`#allloads button[data-test="${floorId}"]`).click();
  await page.fill('#tf-label', 'Kitchen thermostat');
  await page.click('#tf-start');
  await page.waitForFunction(() => document.getElementById('tests')!.textContent!.includes('Kitchen thermostat'));
  expect((homey.settings.get('experiments') as any[])[0]).toMatchObject({ loadId: floorId, label: 'Kitchen thermostat', hours: 4 });
  await page.waitForFunction(() => document.getElementById('running')!.innerText.includes('Test running'));

  // Settings: saved as typed, the COP clamped to what a heat pump can do.
  await page.click('#settings > summary');
  await page.fill('#currency', 'NOK');
  await page.fill('#flat', '1.5');
  await page.fill('#cop', '12');
  await page.selectOption('#model', 'claude-sonnet-5-5');
  await page.click('#b-save');
  await page.waitForFunction(() => document.getElementById('saved')!.textContent === 'Saved');
  expect(homey.settings.get('currency')).toBe('NOK');
  expect(homey.settings.get('flat_price')).toBe(1.5);
  expect(homey.settings.get('heat_pump_cop')).toBe(8);
  expect(homey.settings.get('ai_model')).toBe('claude-sonnet-5-5');
  expect(homey.settings.get('anthropic_api_key')).toBeNull();

  // The summary button writes one now (template: no key).
  await page.click('#b-summary');
  await page.waitForFunction(() => /Last \d days/.test(document.getElementById('summary')!.innerText));
  expect(await text(page, '#summary')).toContain('Template');

  expect(errors).toEqual([]);
  await page.close();
}, 120_000);

maybe('widget while the floor runs: live total, the load by name, fits its tile in both themes', async () => {
  await sim.until(() => !house.isOn('floor', homey.now), 70 * MIN);
  await sim.until(() => house.isOn('floor', homey.now), 70 * MIN);
  await sim.advance(5 * MIN);
  const total = (await widgetApi.getNow({ homey })).totalW;

  for (const dark of [true, false]) {
    const { page, errors } = await open('widgets/now/public/index.html', { width: 360, height: 360, dark });
    await page.waitForFunction(() => document.getElementById('rows')!.innerText.includes('Kitchen floor'));
    expect(await text(page, '#total')).toBe(`${total.toLocaleString('en-US')}W`);
    expect(await text(page, '#rows')).toMatch(/Kitchen floor · 5 min\s+1,3[34]0 W/);
    expect(await text(page, '#rows')).toMatch(/Always on/);
    expect(await text(page, '#rows')).not.toMatch(/NaN/);
    expect(await page.locator('#bar > div').count()).toBeGreaterThanOrEqual(2);
    expect(await text(page, '#finding')).toMatch(/NOK\/month/);
    // The tile is 360 px high (widget.compose.json); the content must fit without scrolling.
    expect(await page.evaluate(() => document.body.scrollHeight)).toBeLessThanOrEqual(360);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
    expect(errors).toEqual([]);

    // The next refresh follows the house: the floor stops, its row goes (last pass only).
    if (!dark) {
      await sim.until(() => !house.isOn('floor', homey.now), 30 * MIN);
      await sim.advance(MIN);
      await page.evaluate(() => (window as any).reload());
      await page.waitForFunction(() => !document.getElementById('rows')!.innerText.includes('Kitchen floor'));
    }
    await page.close();
  }
}, 120_000);
