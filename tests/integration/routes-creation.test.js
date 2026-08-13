const request = require('supertest');
const app = require('../../src/server');
const Route = require('../../src/models/Route');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createDriver } = require('./factories');

// POST /api/routes had zero test coverage despite TEST_PLAN_INTEGRATION.md
// claiming otherwise (issue #18). Covers the happy path, the admin-only guard,
// and field validation.

let managerToken;
let driverToken;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  ({ token: managerToken } = await createManager({ name: 'Route Admin' }));
  ({ token: driverToken } = await createDriver({ name: 'Route Driver' }));
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

let seq = 0;
const routePayload = (overrides = {}) => ({
  routeId: `RTCREATE-${Date.now()}-${seq++}`,
  routeName: 'New Route',
  source: 'Colombo',
  destination: 'Kandy',
  distance: 115,
  fare: 250,
  estimatedTime: 180,
  ...overrides
});

describe('POST /api/routes', () => {
  it('creates a route when called by an admin/manager', async () => {
    const body = routePayload();
    const res = await request(app).post('/api/routes')
      .set('Authorization', `Bearer ${managerToken}`)
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.routeId).toBe(body.routeId);
    expect(res.body.data.serviceType).toBe('PUBLIC');

    const stored = await Route.findOne({ routeId: body.routeId });
    expect(stored).not.toBeNull();
    expect(stored.createdBy).toBeTruthy();
  });

  it('refuses a non-admin caller', async () => {
    const res = await request(app).post('/api/routes')
      .set('Authorization', `Bearer ${driverToken}`)
      .send(routePayload());

    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app).post('/api/routes').send(routePayload());

    expect(res.status).toBe(401);
  });

  it('rejects a duplicate routeId', async () => {
    const body = routePayload();
    const first = await request(app).post('/api/routes')
      .set('Authorization', `Bearer ${managerToken}`).send(body);
    expect(first.status).toBe(201);

    const again = await request(app).post('/api/routes')
      .set('Authorization', `Bearer ${managerToken}`).send(body);
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/already exists/i);
  });

  it.each([
    ['missing routeName', { routeName: '' }],
    ['missing source', { source: '' }],
    ['missing destination', { destination: '' }],
    ['non-positive distance', { distance: 0 }],
    ['non-positive fare', { fare: 0 }],
    ['invalid routeId characters', { routeId: 'bad id!' }]
  ])('rejects %s', async (_label, overrides) => {
    const res = await request(app).post('/api/routes')
      .set('Authorization', `Bearer ${managerToken}`)
      .send(routePayload(overrides));

    expect(res.status).toBe(400);
  });

  it('rejects an invalid serviceType', async () => {
    const res = await request(app).post('/api/routes')
      .set('Authorization', `Bearer ${managerToken}`)
      .send(routePayload({ serviceType: 'NOT_A_TYPE' }));

    expect(res.status).toBe(400);
  });
});
