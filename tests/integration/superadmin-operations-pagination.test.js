const request = require('supertest');
const app = require('../../src/server');
const SuperAdmin = require('../../src/models/SuperAdmin');
const Manager = require('../../src/models/Manager');
const ManagerVehicleRequest = require('../../src/models/ManagerVehicleRequest');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Covers pagination on the two previously-unbounded super-admin list endpoints
// (issue #63): GET /api/super-admin/operations and GET /api/super-admin/vehicle-requests.
// Pagination is opt-in (same convention as vehicleController.getAllRoutes, issue #62/#63) —
// a caller that doesn't pass page/limit keeps getting the full list, unchanged, so the
// existing web-admin dashboard (which calls these with no params) isn't silently truncated.

const SEED_COUNT = 25;

let superAdminToken;
let seedManagerId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  const superAdmin = await SuperAdmin.create({
    name: 'Super Admin', email: `sa-ops-pg-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    isEmailVerified: true, isActive: true
  });
  const login = await request(app).post('/api/auth/login').send({ email: superAdmin.email, password: 'P@ssw0rd!' });
  superAdminToken = login.body.accessToken;

  const managers = await Manager.insertMany(
    Array.from({ length: SEED_COUNT }, (_, i) => ({
      name: `Ops Pagination Manager ${i}`,
      email: `ops-pg-mgr-${i}-${Date.now()}@test.com`,
      password: 'P@ssw0rd!',
      isEmailVerified: true,
      isActive: true
    }))
  );
  seedManagerId = managers[0]._id;

  await ManagerVehicleRequest.insertMany(
    Array.from({ length: SEED_COUNT }, (_, i) => ({
      type: 'CREATE_VEHICLE_ACCOUNT',
      status: 'PENDING',
      managerId: seedManagerId,
      vehicleId: `OPS-PG-V-${i}`,
      payload: {}
    }))
  );
});

afterAll(async () => {
  await closeTestDb();
});

const auth = () => ['Authorization', `Bearer ${superAdminToken}`];

describe('GET /api/super-admin/operations pagination', () => {
  it('returns the full unbounded list when no page/limit is given (unchanged default)', async () => {
    const res = await request(app).get('/api/super-admin/operations').set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(SEED_COUNT);
    expect(res.body.pagination).toBeUndefined();
  });

  it('paginates once page/limit is passed and reports pagination metadata', async () => {
    const res = await request(app).get('/api/super-admin/operations?page=1&limit=10').set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(10);
    expect(res.body.pagination).toEqual({ page: 1, limit: 10, total: SEED_COUNT, pages: 3 });
  });

  it('clamps an oversized requested limit to 100', async () => {
    const res = await request(app).get('/api/super-admin/operations?limit=999999').set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
    expect(res.body.data.length).toBe(SEED_COUNT);
  });
});

describe('GET /api/super-admin/vehicle-requests pagination', () => {
  it('returns the full unbounded list when no page/limit is given (unchanged default)', async () => {
    const res = await request(app).get('/api/super-admin/vehicle-requests?status=ALL').set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(SEED_COUNT);
    expect(res.body.pagination).toBeUndefined();
  });

  it('paginates once page/limit is passed and reports pagination metadata', async () => {
    const res = await request(app).get('/api/super-admin/vehicle-requests?status=ALL&page=2&limit=10').set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(10);
    expect(res.body.pagination).toEqual({ page: 2, limit: 10, total: SEED_COUNT, pages: 3 });
  });

  it('clamps an oversized requested limit to 100', async () => {
    const res = await request(app).get('/api/super-admin/vehicle-requests?status=ALL&limit=999999').set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
    expect(res.body.data.length).toBe(SEED_COUNT);
  });
});
