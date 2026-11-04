const { cleanTrace } = require('../../src/utils/mapMatch/clean');

// A driver's raw GPS trace is noisy: low-accuracy fixes, teleports, a cloud of
// points while the vehicle stands still. cleanTrace removes that before the
// trace is sent to the map matcher.

// ~11.1 m per 0.0001 degree of latitude.
const fix = (i, extra = {}) => ({ lat: 6.9 + i * 0.0002, lng: 79.85, t: 1_000_000 + i * 5000, ...extra });

describe('cleanTrace', () => {
  test('keeps a clean, well-spaced trace unchanged', () => {
    const trace = Array.from({ length: 10 }, (_, i) => fix(i));
    expect(cleanTrace(trace)).toHaveLength(10);
  });

  test('drops fixes whose accuracy is worse than the limit', () => {
    const trace = [fix(0), fix(1, { acc: 120 }), fix(2), fix(3)];
    const out = cleanTrace(trace);
    expect(out).not.toContain(trace[1]);
    expect(out).toHaveLength(3);
  });

  test('keeps a fix with no accuracy value', () => {
    const trace = [fix(0), fix(1), fix(2)];
    expect(cleanTrace(trace)).toHaveLength(3);
  });

  test('drops a teleport that implies an impossible speed', () => {
    const trace = [fix(0), fix(1), { lat: 7.5, lng: 80.5, t: fix(1).t + 1000 }, fix(2), fix(3)];
    const out = cleanTrace(trace);
    expect(out.find((p) => p.lat === 7.5)).toBeUndefined();
    expect(out).toHaveLength(4);
  });

  test('collapses a stationary GPS cloud into a single point', () => {
    const parked = Array.from({ length: 40 }, (_, i) => ({
      lat: 6.9 + (i % 3) * 0.00003,
      lng: 79.85 + (i % 2) * 0.00003,
      t: 2_000_000 + i * 2000
    }));
    const trace = [fix(0), ...parked, { lat: 6.91, lng: 79.85, t: 2_100_000 }];
    const out = cleanTrace(trace);
    expect(out.length).toBeLessThan(6);
  });

  test('puts out-of-order fixes into time order', () => {
    const trace = [fix(0), fix(2), fix(1), fix(3)];
    const out = cleanTrace(trace);
    expect(out.map((p) => p.t)).toEqual([...out.map((p) => p.t)].sort((a, b) => a - b));
  });

  test('always keeps the final fix', () => {
    const trace = [fix(0), fix(1), { lat: fix(1).lat + 0.00003, lng: 79.85, t: fix(1).t + 1000 }];
    const out = cleanTrace(trace);
    expect(out[out.length - 1]).toBe(trace[2]);
  });

  test('ignores malformed entries and non-array input', () => {
    expect(cleanTrace(null)).toEqual([]);
    expect(cleanTrace([null, { lat: 'x', lng: 1 }, { lat: 95, lng: 0 }, fix(0)])).toHaveLength(1);
  });
});
