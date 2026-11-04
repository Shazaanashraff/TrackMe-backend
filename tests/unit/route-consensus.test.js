const { buildConsensus, pickConsensusRun, buildStops } = require('../../src/utils/routeConsensus');
const {
  resamplePolyline,
  coverageFraction,
  projectOntoPolyline,
  polylineLengthMeters
} = require('../../src/utils/geo');

// Five rides are merged into one route by picking the ride that agrees most with
// the others. Roads here are straight lines so the geometry is easy to reason
// about: ~0.0001 degree of latitude is ~11 m.

const line = (lat0, lng0, lat1, lng1, n = 60) =>
  Array.from({ length: n }, (_, i) => ({
    lat: lat0 + ((lat1 - lat0) * i) / (n - 1),
    lng: lng0 + ((lng1 - lng0) * i) / (n - 1)
  }));

// The "normal" road: straight north for ~2.2 km.
const main = () => line(6.9, 79.85, 6.92, 79.85);
// A shifted-but-parallel copy (a few metres off, as GPS would produce).
const jitter = (coords, dLng) => coords.map((c) => ({ lat: c.lat, lng: c.lng + dLng }));
// A day the driver took a detour: leaves the main road for ~1 km in the middle.
const detour = () => [
  ...line(6.9, 79.85, 6.908, 79.85, 20),
  ...line(6.908, 79.85, 6.908, 79.86, 15),
  ...line(6.908, 79.86, 6.912, 79.86, 10),
  ...line(6.912, 79.86, 6.912, 79.85, 15),
  ...line(6.912, 79.85, 6.92, 79.85, 20)
];
// Half a ride: stops mid-way.
const half = () => line(6.9, 79.85, 6.91, 79.85, 30);

describe('geo helpers used by the consensus', () => {
  test('polylineLengthMeters measures a known stretch', () => {
    const len = polylineLengthMeters(line(6.9, 79.85, 6.91, 79.85));
    expect(len).toBeGreaterThan(1100);
    expect(len).toBeLessThan(1120);
  });

  test('resamplePolyline spaces points about the requested distance and keeps the end', () => {
    const src = line(6.9, 79.85, 6.91, 79.85, 4);
    const out = resamplePolyline(src, 10);
    expect(out[0]).toEqual(src[0]);
    expect(out[out.length - 1]).toEqual(src[src.length - 1]);
    expect(out.length).toBeGreaterThan(100);
  });

  test('resamplePolyline returns [] for fewer than two points', () => {
    expect(resamplePolyline([{ lat: 1, lng: 1 }], 10)).toEqual([]);
  });

  test('coverageFraction is 1 on the same line and 0 far away', () => {
    const a = resamplePolyline(main(), 10);
    expect(coverageFraction(a, main(), 25)).toBe(1);
    expect(coverageFraction(a, line(7.5, 80.5, 7.52, 80.5), 25)).toBe(0);
    expect(coverageFraction([], main())).toBe(0);
  });

  test('projectOntoPolyline reports the distance along the line', () => {
    const proj = projectOntoPolyline({ lat: 6.91, lng: 79.8501 }, main());
    expect(proj.alongMeters).toBeGreaterThan(1090);
    expect(proj.alongMeters).toBeLessThan(1130);
    expect(proj.distanceMeters).toBeLessThan(15);
    expect(projectOntoPolyline({ lat: 0, lng: 0 }, [])).toBeNull();
  });
});

describe('pickConsensusRun', () => {
  test('returns null when there is nothing usable', () => {
    expect(pickConsensusRun([])).toBeNull();
    expect(pickConsensusRun([{ id: 1, coords: [] }])).toBeNull();
  });

  test('a single ride is the consensus', () => {
    const pick = pickConsensusRun([{ id: 1, coords: main() }]);
    expect(pick.winnerIndex).toBe(0);
    expect(pick.confidence).toBe(1);
  });

  test('a detour day loses the vote', () => {
    const runs = [
      { id: 'a', coords: main() },
      { id: 'b', coords: jitter(main(), 0.00004) },
      { id: 'c', coords: detour() },
      { id: 'd', coords: jitter(main(), -0.00004) },
      { id: 'e', coords: main() }
    ];
    const pick = pickConsensusRun(runs);
    expect(pick.winnerIndex).not.toBe(2);
    expect(pick.agreeing).toBe(4);
  });

  test('a half-ride can never win, even if the others disagree with each other', () => {
    const runs = [
      { id: 'a', coords: half() },
      { id: 'b', coords: half() },
      { id: 'c', coords: main() },
      { id: 'd', coords: jitter(main(), 0.00004) },
      { id: 'e', coords: main() }
    ];
    const pick = pickConsensusRun(runs);
    expect([2, 3, 4]).toContain(pick.winnerIndex);
  });
});

describe('buildConsensus', () => {
  const fiveGoodRuns = () => [0, 0.00003, -0.00003, 0.00002, -0.00002].map((d, i) => ({
    id: `r${i}`,
    coords: jitter(main(), d),
    durationSec: 1500 + i * 60,
    stops: [{ lat: 6.905, lng: 79.8501, name: 'School gate' }, { lat: 6.915, lng: 79.8499 }]
  }));

  test('five agreeing rides give a confident route with no warning', () => {
    const out = buildConsensus(fiveGoodRuns());
    expect(out.warning).toBe('');
    expect(out.confidence).toBeGreaterThan(0.95);
    expect(out.agreeing).toBe(5);
    expect(out.distanceKm).toBeGreaterThan(2);
    expect(out.estimatedTimeMin).toBe(27);
    expect(out.stops).toHaveLength(2);
  });

  test('rides that do not agree raise RUNS_DISAGREE', () => {
    const runs = [
      { id: 'a', coords: main() },
      { id: 'b', coords: line(6.9, 79.86, 6.92, 79.86) },
      { id: 'c', coords: line(6.9, 79.87, 6.92, 79.87) },
      { id: 'd', coords: line(6.9, 79.88, 6.92, 79.88) },
      { id: 'e', coords: line(6.9, 79.89, 6.92, 79.89) }
    ];
    expect(buildConsensus(runs).warning).toBe('RUNS_DISAGREE');
  });

  test('returns null for no usable rides', () => {
    expect(buildConsensus([])).toBeNull();
  });
});

describe('buildStops', () => {
  const road = main();

  test('keeps a stop most rides agree on, projected onto the line and named', () => {
    const perRun = [
      [{ lat: 6.905, lng: 79.8502, name: 'Gate' }],
      [{ lat: 6.9051, lng: 79.8498, name: 'Gate' }],
      [{ lat: 6.9049, lng: 79.8501 }],
      [],
      [{ lat: 6.905, lng: 79.8501, name: 'Gate' }]
    ];
    const stops = buildStops(perRun, road);
    expect(stops).toHaveLength(1);
    expect(stops[0].stopName).toBe('Gate');
    expect(stops[0].order).toBe(1);
    expect(Math.abs(stops[0].lng - 79.85)).toBeLessThan(0.00002);
  });

  test('drops a stop only one ride tapped', () => {
    const perRun = [[{ lat: 6.905, lng: 79.85 }], [], [], [], []];
    expect(buildStops(perRun, road)).toEqual([]);
  });

  test('orders stops along the route and gives unnamed stops a default name', () => {
    const tap = (lat) => ({ lat, lng: 79.85 });
    const perRun = [
      [tap(6.915), tap(6.905)],
      [tap(6.915), tap(6.905)],
      [tap(6.915), tap(6.905)]
    ];
    const stops = buildStops(perRun, road);
    expect(stops.map((s) => s.stopName)).toEqual(['Stop 1', 'Stop 2']);
    expect(stops[0].lat).toBeLessThan(stops[1].lat);
  });

  test('the name most rides gave wins when drivers typed it differently', () => {
    const at = (name) => [{ lat: 6.905, lng: 79.85, name }];
    const stops = buildStops([at("Nimal's house"), at("Nimal's house"), at('Nimals house'), at(''), at("Nimal's house")], road);
    expect(stops).toHaveLength(1);
    expect(stops[0].stopName).toBe("Nimal's house");
  });

  test('a name given on only one ride is still used when the others left the stop unnamed', () => {
    const tap = (name) => [{ lat: 6.905, lng: 79.85, name }];
    const stops = buildStops([tap(''), tap(''), tap("Kamala's house"), tap(''), tap('')], road);
    expect(stops[0].stopName).toBe("Kamala's house");
  });

  test('several named stops keep their own names and come out in route order', () => {
    const tap = (lat, name) => ({ lat, lng: 79.85, name });
    const ride = [tap(6.915, 'School gate'), tap(6.903, "Nimal's house"), tap(6.909, "Kamala's house")];
    const stops = buildStops([ride, ride, ride, ride, ride], road);
    expect(stops.map((s) => s.stopName)).toEqual(["Nimal's house", "Kamala's house", 'School gate']);
    expect(stops.map((s) => s.order)).toEqual([1, 2, 3]);
  });

  test('a whitespace-only name counts as no name', () => {
    const tap = [{ lat: 6.905, lng: 79.85, name: '   ' }];
    expect(buildStops([tap, tap, tap], road)[0].stopName).toBe('Stop 1');
  });

  test('handles no taps at all', () => {
    expect(buildStops([[], [], []], road)).toEqual([]);
    expect(buildStops([], road)).toEqual([]);
  });
});
