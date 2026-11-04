const {
  ARRIVE_RADIUS_M,
  LEAVE_RADIUS_M,
  metersBetween,
  newTripState,
  usableStops,
  step,
  assignPickups
} = require('../../src/utils/stopArrival');

// A straight road due north from (6.9, 79.86): `at(m)` is the point m metres along it.
const BASE = { lat: 6.9, lng: 79.86 };
const at = (m, sideM = 0) => ({
  lat: BASE.lat + m / 111320,
  lng: BASE.lng + sideM / (111320 * Math.cos(BASE.lat * Math.PI / 180))
});

const stops = [
  { order: 1, stopName: 'Nimal house', ...at(500) },
  { order: 2, stopName: 'School gate', ...at(1500) }
];

describe('metersBetween', () => {
  it('is about 111 km per degree of latitude and shrinks with latitude for longitude', () => {
    expect(metersBetween(0, 0, 1, 0)).toBeCloseTo(111320, -2);
    expect(metersBetween(60, 0, 60, 1)).toBeCloseTo(111320 / 2, -2);
    expect(metersBetween(6.9, 79.86, 6.9, 79.86)).toBe(0);
  });
});

describe('usableStops', () => {
  it('drops entries without finite coordinates and tolerates a non-array', () => {
    expect(usableStops([{ lat: 1, lng: 2 }, { lat: null, lng: 2 }, {}, null])).toHaveLength(1);
    expect(usableStops(undefined)).toEqual([]);
  });
});

describe('step', () => {
  it('does nothing while the vehicle is far from every stop', () => {
    const state = newTripState('s1');
    expect(step(state, stops, { ...at(0), speed: 8 })).toEqual({ arrived: null, departed: null });
    expect(state.atStop).toBeNull();
  });

  it('arrives once when the vehicle pulls up inside the arrival radius', () => {
    const state = newTripState('s1');
    const first = step(state, stops, { ...at(500 - 60), speed: 2 });
    expect(first.arrived).toMatchObject({ order: 1, stopName: 'Nimal house' });
    // A second fix at the same place is the same wait, not a second arrival.
    expect(step(state, stops, { ...at(500 - 55), speed: 0 })).toEqual({ arrived: null, departed: null });
  });

  it('does not arrive when driving past at speed', () => {
    const state = newTripState('s1');
    expect(step(state, stops, { ...at(500), speed: 14 }).arrived).toBeNull();
    // ...but does as soon as it slows at the same spot.
    expect(step(state, stops, { ...at(500), speed: 1 }).arrived).toMatchObject({ order: 1 });
  });

  it('treats an unknown speed as possibly stopped', () => {
    expect(step(newTripState('s'), stops, { ...at(500), speed: null }).arrived).toMatchObject({ order: 1 });
    expect(step(newTripState('s'), stops, { ...at(500) }).arrived).toMatchObject({ order: 1 });
  });

  it('ignores a fix too vague to trust', () => {
    expect(step(newTripState('s'), stops, { ...at(500), speed: 0, accuracy: 120 }).arrived).toBeNull();
  });

  it('keeps waiting inside the leave radius and departs beyond it', () => {
    const state = newTripState('s1');
    step(state, stops, { ...at(500), speed: 0 });
    expect(step(state, stops, { ...at(500 + LEAVE_RADIUS_M - 10), speed: 3 }).departed).toBeNull();
    const out = step(state, stops, { ...at(500 + LEAVE_RADIUS_M + 10), speed: 8 });
    expect(out.departed).toMatchObject({ order: 1 });
    expect(state.atStop).toBeNull();
    expect(state.done.has(1)).toBe(true);
  });

  it('GPS jitter between the two radii never flips the state', () => {
    const state = newTripState('s1');
    step(state, stops, { ...at(500), speed: 0 });
    for (const m of [ARRIVE_RADIUS_M + 5, ARRIVE_RADIUS_M + 40, ARRIVE_RADIUS_M - 20, LEAVE_RADIUS_M - 5]) {
      expect(step(state, stops, { ...at(500 + m), speed: 0 })).toEqual({ arrived: null, departed: null });
    }
  });

  it('never announces the same stop twice in one trip', () => {
    const state = newTripState('s1');
    step(state, stops, { ...at(500), speed: 0 });
    step(state, stops, { ...at(800), speed: 8 }); // left
    expect(step(state, stops, { ...at(500), speed: 0 }).arrived).toBeNull(); // came back
  });

  it('handles a whole route: each stop once, in order', () => {
    const state = newTripState('s1');
    const events = [];
    for (let m = 0; m <= 2000; m += 10) {
      const out = step(state, stops, { ...at(m), speed: m % 500 === 0 ? 0 : 9 });
      if (out.arrived) events.push(['arrive', out.arrived.order, m]);
      if (out.departed) events.push(['depart', out.departed.order, m]);
    }
    expect(events.map((e) => e.slice(0, 2))).toEqual([
      ['arrive', 1], ['depart', 1], ['arrive', 2], ['depart', 2]
    ]);
  });

  it('picks the nearest of two stops that are both in range', () => {
    const close = [
      { order: 1, stopName: 'A', ...at(500) },
      { order: 2, stopName: 'B', ...at(530) }
    ];
    expect(step(newTripState('s'), close, { ...at(525), speed: 0 }).arrived.order).toBe(2);
  });

  it('ignores a non-finite fix', () => {
    expect(step(newTripState('s'), stops, { lat: NaN, lng: 79.86 })).toEqual({ arrived: null, departed: null });
  });

  it('a new trip starts clean even after the last one finished every stop', () => {
    const first = newTripState('morning');
    first.done.add(1);
    const second = newTripState('afternoon');
    expect(step(second, stops, { ...at(500), speed: 0 }).arrived).toMatchObject({ order: 1 });
  });
});

describe('assignPickups', () => {
  it('gives each rider the nearest stop within range, and none to a far-off rider', () => {
    const near1 = { studentId: 'a', ...at(520, 20) };
    const near2 = { studentId: 'b', ...at(1480, -10) };
    const far = { studentId: 'c', ...at(5000) };
    const map = assignPickups([near1, near2, far], stops);
    expect(map.get(1)).toEqual([near1]);
    expect(map.get(2)).toEqual([near2]);
    expect([...map.values()].flat()).not.toContain(far);
  });

  it('two riders at one stop both belong to it, and a rider is never in two stops', () => {
    const a = { studentId: 'a', ...at(505) };
    const b = { studentId: 'b', ...at(495) };
    const map = assignPickups([a, b], stops);
    expect(map.get(1)).toHaveLength(2);
    expect(map.has(2)).toBe(false);
  });

  it('handles empty input', () => {
    expect(assignPickups([], stops).size).toBe(0);
    expect(assignPickups([{ studentId: 'a', ...at(500) }], []).size).toBe(0);
    expect(assignPickups(undefined, undefined).size).toBe(0);
  });
});

describe('cost per GPS fix', () => {
  it('stays tiny with 200 stops and 20,000 fixes', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ order: i + 1, stopName: `S${i}`, ...at(i * 100) }));
    const state = newTripState('perf');
    const started = process.hrtime.bigint();
    for (let i = 0; i < 20000; i += 1) {
      step(state, many, { ...at((i * 1.1) % 20000), speed: 9 });
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // ~8 ms on a laptop; the bound is loose so a slow CI box is not flaky.
    expect(ms).toBeLessThan(500);
  });
});
