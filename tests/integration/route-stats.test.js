const request = require('supertest');
const app = require('../../src/server');
const Route = require('../../src/models/Route');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Covers GET /api/routes/stats/overview (issue #12: collapsed from 4 queries into
// one $facet aggregation — response shape must stay identical).

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  await Route.insertMany([
    { routeId: 'STATS-1', routeName: 'A', source: 'X', destination: 'Y', distance: 10, estimatedTime: 20, fare: 50, serviceType: 'PUBLIC', isActive: true },
    { routeId: 'STATS-2', routeName: 'B', source: 'X', destination: 'Y', distance: 20, estimatedTime: 40, fare: 50, serviceType: 'PUBLIC', isActive: true },
    { routeId: 'STATS-3', routeName: 'C', source: 'X', destination: 'Y', distance: 30, estimatedTime: 60, fare: 50, serviceType: 'PUBLIC', isActive: false },
    { routeId: 'STATS-4', routeName: 'D', source: 'X', destination: 'Y', distance: 40, estimatedTime: 80, fare: 50, serviceType: 'PUBLIC', isActive: false, isDeleted: true }
  ]);
});

afterAll(async () => {
  await closeTestDb();
});

describe('GET /api/routes/stats/overview', () => {
  it('returns counts and averages over non-deleted routes only', async () => {
    const res = await request(app).get('/api/routes/stats/overview');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalRoutes).toBe(3);
    expect(res.body.data.activeRoutes).toBe(2);
    expect(res.body.data.inactiveRoutes).toBe(1);
    expect(res.body.data.avgDistance).toBeCloseTo(20);
    expect(res.body.data.avgEstimatedTime).toBeCloseTo(40);
  });
});
