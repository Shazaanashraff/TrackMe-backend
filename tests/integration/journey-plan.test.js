const request = require('supertest');
const app = require('../../src/server');
const Route = require('../../src/models/Route');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { haversineKm, nearestStop, segmentDistanceKm } = require('../../src/utils/geo');

// Coordinates roughly follow real Western Province towns so distances are realistic.
const AVISSAWELLA = { stopName: 'Avissawella', order: 1, lat: 6.9542, lng: 80.2092 };
const HANWELLA = { stopName: 'Hanwella', order: 2, lat: 6.907, lng: 80.085 };
const KADUWELA = { stopName: 'Kaduwela', order: 3, lat: 6.9333, lng: 79.9833 };
const PETTAH = { stopName: 'Pettah', order: 4, lat: 6.9355, lng: 79.8487 };

const MT_LAVINIA = { stopName: 'Mount Lavinia', order: 1, lat: 6.8389, lng: 79.8653 };
const DEHIWALA = { stopName: 'Dehiwala', order: 2, lat: 6.8511, lng: 79.8657 };
const TOWN_HALL = { stopName: 'Town Hall', order: 3, lat: 6.917, lng: 79.8612 };

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  await Route.create([
    {
      routeId: 'TEST-1/3',
      routeName: 'Avissawella - Pettah',
      source: 'Avissawella',
      destination: 'Pettah',
      distance: 60,
      fare: 120,
      serviceType: 'PUBLIC',
      stopsCount: 4,
      stops: [AVISSAWELLA, HANWELLA, KADUWELA, PETTAH],
    },
    {
      routeId: 'TEST-147',
      routeName: 'Mount Lavinia - Town Hall',
      source: 'Mount Lavinia',
      destination: 'Town Hall',
      distance: 12,
      fare: 40,
      serviceType: 'PUBLIC',
      stopsCount: 3,
      stops: [MT_LAVINIA, DEHIWALA, TOWN_HALL],
    },
  ]);
});

afterAll(async () => {
  await closeTestDb();
});

describe('geo utils', () => {
  test('haversineKm matches a known short distance', () => {
    // Avissawella -> Hanwella is ~14 km on the ground.
    const km = haversineKm(AVISSAWELLA.lat, AVISSAWELLA.lng, HANWELLA.lat, HANWELLA.lng);
    expect(km).toBeGreaterThan(10);
    expect(km).toBeLessThan(20);
  });

  test('haversineKm is zero for identical points', () => {
    expect(haversineKm(6.9, 79.8, 6.9, 79.8)).toBeCloseTo(0, 5);
  });

  test('nearestStop returns the closest stop with its index', () => {
    const stops = [AVISSAWELLA, HANWELLA, KADUWELA, PETTAH];
    const res = nearestStop(stops, KADUWELA.lat + 0.001, KADUWELA.lng + 0.001);
    expect(res.index).toBe(2);
    expect(res.stop.stopName).toBe('Kaduwela');
    expect(res.distanceKm).toBeLessThan(1);
  });

  test('nearestStop returns null for empty input', () => {
    expect(nearestStop([], 6.9, 79.8)).toBeNull();
  });

  test('segmentDistanceKm sums consecutive legs', () => {
    const stops = [AVISSAWELLA, HANWELLA, KADUWELA, PETTAH];
    const full = segmentDistanceKm(stops, 0, 3);
    const partial = segmentDistanceKm(stops, 0, 1);
    expect(full).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(0);
  });
});

describe('GET /api/bus/stops', () => {
  test('returns a deduped, sorted list of stops with coordinates', async () => {
    const res = await request(app).get('/api/bus/stops');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    const names = res.body.data.map((s) => s.stopName);
    expect(names).toContain('Avissawella');
    expect(names).toContain('Town Hall');
    // sorted alphabetically
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    // every stop carries coordinates
    expect(res.body.data.every((s) => typeof s.lat === 'number' && typeof s.lng === 'number')).toBe(true);
  });
});

describe('GET /api/bus/routes/plan', () => {
  test('matches a direct route in the correct direction', async () => {
    const res = await request(app).get('/api/bus/routes/plan').query({
      fromLat: AVISSAWELLA.lat,
      fromLng: AVISSAWELLA.lng,
      toLat: KADUWELA.lat,
      toLng: KADUWELA.lng,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const ids = res.body.data.map((m) => m.routeId);
    expect(ids).toContain('TEST-1/3');
    expect(ids).not.toContain('TEST-147'); // nowhere near this trip

    const match = res.body.data.find((m) => m.routeId === 'TEST-1/3');
    expect(match.boardStop.stopName).toBe('Avissawella');
    expect(match.alightStop.stopName).toBe('Kaduwela');
    expect(match.stopsBetween).toBe(2);
    expect(match.fareEstimate).toBeGreaterThan(0);
    expect(match.fareEstimate).toBeLessThanOrEqual(120);
  });

  test('does NOT match when the trip runs against the route direction', async () => {
    const res = await request(app).get('/api/bus/routes/plan').query({
      fromLat: KADUWELA.lat,
      fromLng: KADUWELA.lng,
      toLat: AVISSAWELLA.lat,
      toLng: AVISSAWELLA.lng,
    });
    expect(res.status).toBe(200);
    const ids = res.body.data.map((m) => m.routeId);
    expect(ids).not.toContain('TEST-1/3');
  });

  test('returns no matches when both points are far from every stop', async () => {
    const res = await request(app).get('/api/bus/routes/plan').query({
      fromLat: 7.9,
      fromLng: 81.0, // out east, far from any seeded stop
      toLat: 8.0,
      toLng: 81.1,
    });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  test('rejects requests missing coordinates with 400', async () => {
    const res = await request(app).get('/api/bus/routes/plan').query({
      fromLat: AVISSAWELLA.lat,
      fromLng: AVISSAWELLA.lng,
      // toLat / toLng omitted
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
