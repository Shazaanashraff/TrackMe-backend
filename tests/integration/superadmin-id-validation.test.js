const request = require('supertest');
const app = require('../../src/server');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createSuperAdmin, authHeader } = require('./factories');

// A malformed Mongo ObjectId in these super-admin params/query used to fall through
// to Mongoose's CastError, which errorHandler.js didn't special-case — surfacing as
// an unhelpful 500 that embeds the raw invalid value. See issues #51/#52/#53.

let superAdminToken;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  ({ token: superAdminToken } = await createSuperAdmin({ name: 'Super Admin' }));
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

const auth = () => authHeader(superAdminToken);

describe('super-admin malformed ObjectId handling', () => {
  it('PATCH /vehicle-requests/:requestId/review returns 400, not 500, for a malformed requestId', async () => {
    const res = await request(app)
      .patch('/api/super-admin/vehicle-requests/not-a-valid-id/review')
      .set(...auth())
      .send({ decision: 'APPROVE' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('not-a-valid-id');
  });

  it('GET /vehicle-requests returns 400, not 500, for a malformed managerId query param', async () => {
    const res = await request(app)
      .get('/api/super-admin/vehicle-requests?managerId=not-a-valid-id')
      .set(...auth());

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('not-a-valid-id');
  });

  it('GET /audit-logs returns 400, not 500, for a malformed managerId query param', async () => {
    const res = await request(app)
      .get('/api/super-admin/audit-logs?managerId=not-a-valid-id')
      .set(...auth());

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('not-a-valid-id');
  });

  it('GET /vehicle-requests still returns 200 with no managerId filter applied', async () => {
    const res = await request(app)
      .get('/api/super-admin/vehicle-requests')
      .set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
