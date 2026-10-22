import { clusterActivations } from '../../src/engine/clustering';
import { Activation, Vec3 } from '../../src/engine/types';
import { inRhythmSlot, kindLabel, sessionsOf } from '../../src/insight/appliances';
import { MIN, T0 } from '../helpers/synth';

const act = (startMin: number, minutes: number, delta: Vec3): Activation => ({
  start: T0 + startMin * MIN,
  end: T0 + (startMin + minutes) * MIN,
  delta,
});
const L1 = (w: number): Vec3 => [w, 0, 0];
const labels = (acts: Activation[]) => sessionsOf(acts).map(s => kindLabel(s.kinds));

describe('appliances by the shape of a session', () => {
  test('a dishwasher: two 2 kW heats, 50 min apart', () => {
    expect(labels([act(0, 14, L1(2000)), act(64, 10, L1(1950))])).toEqual(['Dishwasher']);
  });

  test('a washing machine: one 2 kW heat of 18 min', () => {
    expect(labels([act(0, 18, L1(2100))])).toEqual(['Washing machine']);
  });

  test('a condenser dryer: a 2.2 kW element cycling for 90 min', () => {
    const dryer = [act(0, 20, L1(2200)), ...[0, 1, 2, 3, 4, 5].map(i => act(25 + i * 11, 6, L1(2200)))];
    expect(labels(dryer)).toEqual(['Tumble dryer or oven']);
    expect(sessionsOf(dryer)[0].reason).toMatch(/switching 7 times/);
  });

  test('an oven: a heat-up, then short cycles over 45 min', () => {
    const oven = [act(0, 10, L1(1800)), act(15, 3, L1(1800)), act(24, 3, L1(1800)), act(33, 3, L1(1800))];
    expect(labels(oven)).toEqual(['Oven']);
  });

  test('a kettle and a microwave; nothing for a run that fits no pattern', () => {
    expect(labels([act(0, 3, L1(2200))])).toEqual(['Kettle']);
    expect(labels([act(0, 4, L1(1100))])).toEqual(['Microwave or toaster']);
    expect(labels([act(0, 50, L1(2200))])).toEqual(['']);
  });

  test('runs on other phases, or far apart, are separate sessions', () => {
    const s = sessionsOf([act(0, 3, L1(2200)), act(1, 3, [0, 2200, 0]), act(200, 3, L1(2200))]);
    expect(s.map(x => x.phases)).toEqual(['L1', 'L2', 'L1']);
  });

  test('a 3-phase run is no appliance here: a heat pump of kettle size', () => {
    expect(labels([act(0, 2, [300, 300, 300])])).toEqual(['']);
  });

  test('floor heating starting with the heat pump is not a washing machine heat', () => {
    // 1380 W for 21 min every 63 min; one run seen as 2130 W, the heat pump on top (L1 share).
    const floor = [0, 1, 2, 4, 5, 6, 7, 8, 9].map(i => act(i * 63, 21, L1(1380)));
    const [heater] = clusterActivations(floor);
    expect(heater.rhythmic).toBe(true);
    const merged = act(3 * 63 + 1, 21, [1740, 195, 195]);
    expect(inRhythmSlot(merged, [heater])).toBe(true);
    // A real 2.1 kW heat half a cycle off the rhythm is not the floor heating.
    expect(inRhythmSlot(act(3 * 63 + 32, 18, L1(2100)), [heater])).toBe(false);
    // In its slot, but far bigger than the floor heating plus a small load.
    expect(inRhythmSlot(act(3 * 63, 21, L1(3600)), [heater])).toBe(false);
  });
});
