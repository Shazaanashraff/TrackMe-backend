const request = require('supertest');
const app = require('../../src/server');
const Route = require('../../src/models/Route');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { _decodePolyline } = require('../../src/controllers/routeGeometryController');

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  // A single-stop route exercises the no-routing-needed branch (no Google call).
  await Route.create({
    routeId: 'PATH-1',
    routeName: 'One Stop',
    source: 'A',
    destination: 'A',
    fare: 10,
    distance: 0.5,
    estimatedTime: 5,
    serviceType: 'PUBLIC',
    stops: [{ stopName: 'A', order: 1, lat: 6.9, lng: 79.86 }],
  });
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('decodePolyline', () => {
  it('decodes the canonical Google example polyline', () => {
    const coords = _decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(coords).toHaveLength(3);
    expect(coords[0].lat).toBeCloseTo(38.5, 4);
    expect(coords[0].lng).toBeCloseTo(-120.2, 4);
    expect(coords[2].lat).toBeCloseTo(43.252, 3);
    expect(coords[2].lng).toBeCloseTo(-126.453, 3);
  });
});

describe('GET /api/bus/routes/:routeId/path', () => {
  it('404s for an unknown route (no upstream call)', async () => {
    const res = await request(app).get('/api/bus/routes/DOES-NOT-EXIST/path');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('returns the stop coords for a single-stop route without routing', async () => {
    const res = await request(app).get('/api/bus/routes/PATH-1/path');
    expect(res.status).toBe(200);
    expect(res.body.data.coords).toEqual([{ lat: 6.9, lng: 79.86 }]);
  });
});
