# Power Detective (Homey app)

Finds which loads use power in your house from the house meter alone (Tibber Pulse, P1/HAN
readers), says what they cost, and proves it.

- **Loads, not a graph.** Every switch-on and switch-off is found per phase and grouped into
  loads: "1330 W on L1, 21 min every 63 min, 9.6 kWh/day". A 3-phase heat pump, a one-phase
  floor heater and a 400 V heater of the same size look different on three phases; a single
  total-power reading cannot tell them apart.
- **Uses what you already meter.** Devices that measure themselves (EV charger, spa, smart
  plugs, heat pump via MELCloud) are found on the house meter by themselves: the app learns each
  one's phases and reporting delay from the Pulse. Fast reporters are taken out of the house
  meter live, so detection only has to find what nothing meters; slow ones (MELCloud, minutes
  late) are counted by their energy and name the loads that coincide with them, but only when
  the match is unlikely by chance (binomial test against the device's runs shifted out of phase).
- **Every kWh accounted for.** Each day is an energy account that adds up to the house meter:
  metered devices (exact), found loads, always-on, heating explained by outdoor temperature
  (degree-day regression, base 17 °C), and what is left unexplained.
- **Findings in money.** Ranked by what they cost: rhythmic heaters (a thermostat-driven load
  running day and night), heat pump short cycling, base load, loads cheaper at the day's
  cheapest hours.
- **Proved by a switch-off test.** For loads nothing meters: switch off what you think it is,
  start a test, and the app checks (Poisson test against the load's own rate) whether the load
  stopped. Confirmed loads get the name.
- **Found loads as devices.** Add them as devices and Homey Energy shows them beside the metered
  ones. Flows: a load started / stopped, a new finding, a load is running, start a test.
- **AI explains, never detects.** The weekly summary is a template, or written by Claude if you
  add an Anthropic API key, told to use only the numbers it is given.

## How it works

```
house meter, every 10 s (power, current per phase)
  -> house days     the raw meter: what the account must add up to
  -> metered        each metered device's change found on the meter: phases + delay learned;
                    devices reporting within 20 s subtracted live (switched over only while off)
  -> StepDetector   steady-state segmentation per phase (Hart 1992); phase steps that start
                    together are one change, sized by the total active power
  -> decompose      a change where one phase falls and others rise = a running load stopping as
                    another starts; the running loads explain it before it is split by sign
  -> Pairer         stop + start of the same shape (cosine of per-phase steps, size ratio) = an
                    activation
  -> clustering     activations grouped by phases and size into loads; rhythm from the robust
                    spread of the time between starts
  -> analysis       names from metered devices (and user, and passed tests), energy account
                    (meters, loads, always-on, weather heating, unexplained), findings, tests
```

A run far longer than its load ever runs (beyond Q3 + 3 IQR + 10 min of its run lengths) is a
missed stop: its energy counts at the load's median length, and it no longer shows as running.

All detection is in `src/engine` (pure TypeScript, no Homey), so the app, the tests and the
benchmarks run the same code.

## Benchmarks (the judge is not the code)

`npm run bench:deddiag -- <dir> [fold1] [annotations]` runs on DEDDIAG house 8 (Wenninger et al., *Scientific Data*
2021, figshare 13615073): 326 days of 3-phase mains from a German home, resampled to 10 s
snapshots like a Swedish HAN meter. Loads and their names are learned on alternating 14-day
blocks; the other blocks are scored against the plug meters of the dishwasher and the washing
machine. Runs during mains-logger outages (20 % of the data) are left out and counted.

Two folds (learn on even blocks, score odd; then the reverse):

| Appliance (held-out) | Fold | Precision | Recall | F1 | Energy found |
|---|---|---|---|---|---|
| Dishwasher (L3 heater) | 0 | 0.97 | 0.96 | **0.97** | 82 % |
| Dishwasher (L3 heater) | 1 | 0.98 | 0.95 | **0.97** | 84 % |
| Washing machine (L3 heater) | 0 | 0.85 | 0.87 | **0.86** | 60 % |
| Washing machine (L3 heater) | 1 | 0.82 | 0.98 | **0.90** | 58 % |

"Energy found" is low because pumps and motors draw less than the smallest step the engine
reports; the heaters, which use most of the energy, are found.

The target was F1 ≥ 0.90 on both appliances: met for the dishwasher, met on one fold and missed
on the other for the washing machine, whose 2 kW heater shares its phase and size with a
kettle-like load.

`npm run bench:homey -- <dir> [hr]` runs on one house's Homey Insights export and scores the
heat pump against MELCloud's own run records. The 6-hour export has one value a minute
(averages), which smears a 4-minute compressor run over its phases: heat pump F1 0.72
(precision 1.00, recall 0.56). The live app reads 10 s values, like the benchmark above.

Benchmark data is not in the repository (`bench-data/` is ignored).

## Install

```
npm install
npx homey app install     # or: npx homey app run
```

Open the app's settings: pick the house meter if more than one is found, set currency and a
flat price (prices are read from the Tibber home device when present), optionally an Anthropic
API key for the weekly summary.

On the Homey dashboard, add the **Power right now** widget (Edit dashboard → Add widget → Power
Detective). It shows live power split into named loads, the always-on base and what is not yet
recognised, today's kWh and how much of it is explained, and the finding worth most money. It
refreshes every 15 s. Naming loads, tests and settings stay in the app's settings page.

## Develop

```
npm test                  # unit and system tests
npm run test:unit         # engine, judge, insight and Homey wiring, piece by piece
npm run test:system       # the whole app in a simulated house (below)
npm run lint              # type check
npm run validate          # homey app validate --level verified
```

### System tests

`test/system/harness.ts` runs the real app against a fake Homey with a virtual clock and a
simulated house: a floor heater on L1 every 63 min, a 3-phase heat pump metered by its own device,
a kettle and an oven, a solar inverter, hourly prices. The app's own timers do the work; the tests
only move the clock and use what a user or Homey uses: `api.ts`, the widget API, flow cards, the
load driver and its devices. The house keeps the ground truth, and that is the judge.

| File | What it proves |
|---|---|
| `house.test.ts` | A week, step by step: loads found unaided (floor heater and heat pump found every time on runs not switching together with another load; F1 ≥ 0.95 / ≥ 0.85 overall), named from the metered device, price and base load right, findings announced once; flows fire for the right load; naming; the widget; a paired device meters its runs within 5 %; a switch-off test confirms the right load and rejects a wrong guess; a restart mid-run keeps ids, names and the run; one weekly summary. |
| `failures.test.ts` | Homey API not ready at boot, two meters and no choice, a meter without phase data, the Pulse going quiet, garbage values, a corrupt saved state, no driver. |
| `account.test.ts` | A house where much is metered (Easee at once, spa 10 s late, a modulating heat pump through MELCloud 3 min late) plus radiators following the outdoor temperature: the fast devices learned and subtracted, MELCloud not; the floor heater found every time while the car charges; every day adds up to the house meter, device rows equal their meters, nothing counted twice; the heating estimate equals the radiators' energy within 15 % and always-on the true base; the widget lists each device once and no stale runs. |
| `pages.test.ts` | The settings page and the widget in Chromium, wired to the running app: what they show, that naming, tests, settings and the summary button land in the app, both themes, phone width, the widget fitting its 360 px tile. Skipped when no Chromium is found (`PD_CHROMIUM` or Playwright's). |

Known limits, measured here: two loads switching within the same few seconds are seen as one
change; in the simulated house that costs the heat pump 2 of 19 runs over two days. A switch-off
hidden by a heat pump's power step is a missed stop: in the metered house, the floor heater's
energy came out 5.8 % low over the first two days from one such miss.
