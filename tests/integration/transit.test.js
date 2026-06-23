const request = require('supertest');
const app = require('../../src/server');
const { _normalizeRoute } = require('../../src/controllers/transitController');

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
