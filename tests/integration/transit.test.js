const request = require('supertest');
const app = require('../../src/server');
const { _normalizeRoute, _groupRoutes, _pruneRedundant } = require('../../src/controllers/transitController');

// A trimmed Google Routes API TRANSIT route (walk -> bus -> walk).
const sampleRoute = {
  duration: '1620s',
  polyline: { encodedPolyline: 'abc123' },
  legs: [{
    steps: [
      { travelMode: 'WALK', distanceMeters: 79, staticDuration: '60s', polyline: { encodedPolyline: 'w1' } },
      { travelMode: 'WALK', distanceMeters: 10, staticDuration: '8s', polyline: { encodedPolyline: 'w2' } },
      {
        travelMode: 'TRANSIT',
        staticDuration: '1380s',
        polyline: { encodedPolyline: 'bus1' },
        transitDetails: {
          transitLine: { nameShort: '100', name: 'Panadura-Pettah', vehicle: { type: 'BUS' } },
          stopDetails: { departureStop: { name: 'Pettah Bus Stop' }, arrivalStop: { name: 'Wellawatte' } },
          stopCount: 22,
          headsign: 'Panadura',
          headway: '480s',
          localizedValues: { departureTime: { time: { text: '15.29' } }, arrivalTime: { time: { text: '15.52' } } },
        },
      },
      { travelMode: 'WALK', distanceMeters: 101, staticDuration: '90s', polyline: { encodedPolyline: 'w3' } },
    ],
  }],
};

describe('transit _normalizeRoute', () => {
  const r = _normalizeRoute(sampleRoute);

  it('extracts the bus line and durations', () => {
    expect(r.durationSec).toBe(1620);
    expect(r.buses).toEqual(['100']);
    expect(r.transfers).toBe(0);
    expect(r.departureTime).toBe('15.29');
    expect(r.arrivalTime).toBe('15.52');
    expect(r.polyline).toBe('abc123');
  });

  it('sums all walking (including collapsed trivial legs)', () => {
    expect(r.walkMeters).toBe(190); // 79 + 10 + 101
  });

  it('keeps every step in order with geometry + durations', () => {
    const types = r.legs.map((l) => l.type);
    expect(types).toEqual(['WALK', 'WALK', 'BUS', 'WALK']);
    const bus = r.legs.find((l) => l.type === 'BUS');
    expect(bus.stops).toBe(22);
    expect(bus.headwaySec).toBe(480);
    expect(bus.durationSec).toBe(1380);
    expect(bus.polyline).toBe('bus1');
    expect(r.legs[0].polyline).toBe('w1');
    expect(r.legs[0].durationSec).toBe(60);
  });
});

describe('transit _groupRoutes (Maps-style interchangeable-bus grouping)', () => {
  // Two "direct" trips with the SAME board->alight, different bus line.
  const directA = mkDirect('3', 'Brandiyawatta', 'Colombo Fort', 4440, 2581);
  const directB = mkDirect('98', 'Brandiyawatta', 'Colombo Fort', 4470, 2681);
  // A genuinely different trip (different alight).
  const other = mkDirect('138', 'Pettah', 'Maharagama', 3600, 175);

  function mkDirect(line, board, alight, durationSec, walkMeters) {
    return {
      durationSec, walkMeters, transfers: 0, buses: [line],
      legs: [
        { type: 'WALK', meters: walkMeters, durationSec: 600 },
        { type: 'BUS', line, board, alight, stops: 10, durationSec: durationSec - 600 },
      ],
    };
  }

  it('collapses interchangeable buses (same board->alight) into ONE option', () => {
    const out = _groupRoutes([directA, directB]);
    expect(out).toHaveLength(1);
    const busLeg = out[0].legs.find((l) => l.type === 'BUS');
    expect(busLeg.lines).toEqual(['3', '98']); // both lines listed on the leg
    expect(busLeg.line).toBe('3');             // primary (fastest member)
  });

  it('keeps structurally different trips separate', () => {
    const out = _groupRoutes([directA, directB, other]);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.legs.find((l) => l.type === 'BUS').lines.join('/')).sort())
      .toEqual(['138', '3/98']);
  });

  it('sorts fastest-first and keeps the fastest member as representative', () => {
    const out = _groupRoutes([directB, directA]);
    expect(out[0].durationSec).toBe(4440); // directA is faster
  });
});

describe('transit _pruneRedundant (drop only redundant worse options)', () => {
  // direct option whose first bus leg can be 98 OR 3
  const direct = {
    durationSec: 3120, walkMeters: 960, transfers: 0,
    legs: [{ type: 'WALK', meters: 960 }, { type: 'BUS', line: '98', lines: ['98', '3'], board: 'X', alight: 'Pettah' }],
  };
  // a slower transfer that STARTS with 98 (already offered by `direct`)
  const transferStarting98 = {
    durationSec: 3240, walkMeters: 960, transfers: 1,
    legs: [{ type: 'BUS', line: '98', lines: ['98'], board: 'X', alight: 'Y' }, { type: 'BUS', line: '100', lines: ['100'], board: 'Y', alight: 'Pettah' }],
  };
  // a worse trip but starting with a DIFFERENT bus (15-1-1) → a real new choice
  const transferNewBus = {
    durationSec: 4000, walkMeters: 3500, transfers: 1,
    legs: [{ type: 'BUS', line: '15-1-1', lines: ['15-1-1'], board: 'Z', alight: 'Y' }, { type: 'BUS', line: '2', lines: ['2'], board: 'Y', alight: 'Pettah' }],
  };

  it('drops the slower transfer that reuses an already-offered first bus (98/3 case)', () => {
    const out = _pruneRedundant([direct, transferStarting98]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(direct);
  });

  it('KEEPS a worse option that offers a different first bus (variety preserved)', () => {
    const out = _pruneRedundant([direct, transferNewBus]);
    expect(out).toHaveLength(2);
  });

  it('keeps everything when nothing is both worse and lead-covered', () => {
    const out = _pruneRedundant([direct, transferNewBus, transferStarting98]);
    // direct + transferNewBus kept; transferStarting98 dropped
    expect(out).toHaveLength(2);
    expect(out).toContain(direct);
    expect(out).toContain(transferNewBus);
  });
});

describe('transit service classification + ordering', () => {
  const raw = (name, short, stopCount = 15, distanceMeters = 0) => ({
    duration: '600s',
    legs: [{ steps: [{
      travelMode: 'TRANSIT', staticDuration: '600s', distanceMeters,
      transitDetails: {
        transitLine: { nameShort: short, name },
        stopDetails: { departureStop: { name: 'A' }, arrivalStop: { name: 'B' } },
        stopCount,
      },
    }] }],
  });

  it('flags an intercity line (far terminal) as long distance', () => {
    const r = _normalizeRoute(raw('Colombo-Kataragama', '3'));
    expect(r.serviceClass).toBe('LONG_DISTANCE');
    expect(r.serviceLabel).toBe('Long distance');
  });

  it('treats a Western Province line as local (no badge)', () => {
    const r = _normalizeRoute(raw('Hanwella-Pettah', '143'));
    expect(r.serviceClass).toBe('LOCAL');
    expect(r.serviceLabel).toBeNull();
  });

  it('flags a wide-stop-spacing bus as express even without a known far town', () => {
    // 40 km over 5 stops = 8 km/stop -> skips local stops.
    const r = _normalizeRoute(raw('Some-Local-Sounding', 'X', 5, 40000));
    expect(r.serviceClass).toBe('EXPRESS');
  });

  const mk = (line, cls, dur, board = 'X') => ({
    durationSec: dur, walkMeters: 100, transfers: 0, buses: [line], serviceClass: cls,
    legs: [{ type: 'BUS', line, board, alight: 'Pettah', serviceClass: cls }],
  });

  it('a leg served by a local OR long-distance bus counts as local (rider can pick local)', () => {
    const out = _groupRoutes([mk('2', 'LONG_DISTANCE', 3000), mk('400', 'LOCAL', 3300)]);
    expect(out).toHaveLength(1);
    const bus = out[0].legs.find((l) => l.type === 'BUS');
    expect(bus.serviceClass).toBe('LOCAL');
    expect(bus.lines).toEqual(['400', '2']); // local listed first
    expect(out[0].serviceClass).toBe('LOCAL');
  });

  it('orders local options ahead of a FASTER long-distance one', () => {
    const out = _groupRoutes([mk('2', 'LONG_DISTANCE', 2400, 'P'), mk('400', 'LOCAL', 3000, 'Q')]);
    expect(out.map((o) => o.serviceClass)).toEqual(['LOCAL', 'LONG_DISTANCE']);
  });
});

describe('GET /api/transit/plan guards (no upstream call)', () => {
  it('400s when coords are missing', async () => {
    const res = await request(app).get('/api/transit/plan?fromLat=6.9');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('503s when the server key is not configured', async () => {
    const original = process.env.GOOGLE_PLACES_KEY;
    delete process.env.GOOGLE_PLACES_KEY;
    try {
      const res = await request(app).get('/api/transit/plan?fromLat=6.9&fromLng=79.8&toLat=6.8&toLng=79.86');
      expect(res.status).toBe(503);
    } finally {
      if (original !== undefined) process.env.GOOGLE_PLACES_KEY = original;
    }
  });
});
