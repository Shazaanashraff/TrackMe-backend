const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const Route = require('../../src/models/Route');
const Vehicle = require('../../src/models/Vehicle');
const VehicleReview = require('../../src/models/VehicleReview');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Covers the page-size cap on three previously-unbounded list endpoints (issue #6):
// GET /api/vehicle/list/all, GET /api/vehicle/routes, GET /api/vehicle-reviews/vehicle/:id.
// Each seeds 101 records so an oversized requested limit can be proven capped at 100,
// not just "returned everything we happened to seed".

const MAX_LIMIT = 100;
const SEED_COUNT = MAX_LIMIT + 1;

let userToken;
let vehicleForReviews;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  await Vehicle.insertMany(
    Array.from({ length: SEED_COUNT }, (_, i) => ({
      vehicleId: `PAGE-V-${i}`,
      vehicleName: `Pagination Vehicle ${i}`,
      registrationNumber: `PAGE-REG-${i}`,
      numberPlate: `PAGE-NP-${i}`
    }))
  );

  await Route.insertMany(
    Array.from({ length: SEED_COUNT }, (_, i) => ({
      routeId: `PAGE-R-${i}`,
      routeName: `Pagination Route ${i}`,
      source: 'Origin',
      destination: 'Destination',
      distance: 10,
      fare: 50,
      serviceType: 'PUBLIC',
      stops: []
    }))
  );

  vehicleForReviews = await Vehicle.create({
    vehicleId: 'PAGE-REVIEWS-V',
    vehicleName: 'Review Target Vehicle',
    registrationNumber: 'PAGE-REVIEWS-REG',
    numberPlate: 'PAGE-REVIEWS-NP'
  });

  const reviewer = await User.create({
    name: 'Reviewer', email: `pagination-reviewer-${Date.now()}@test.com`, password: 'P@ssw0rd!',
    role: 'user', isEmailVerified: true, isActive: true
  });
  const login = await request(app).post('/api/auth/login').send({ email: reviewer.email, password: 'P@ssw0rd!' });
  userToken = login.body.accessToken;

  await VehicleReview.insertMany(
    Array.from({ length: SEED_COUNT }, (_, i) => ({
      vehicleId: vehicleForReviews._id,
      userId: reviewer._id,
      rating: 5,
      comment: `Review ${i}`
    }))
  );
});

afterAll(async () => {
  await closeTestDb();
});

describe('List endpoint page-size caps', () => {
  it('GET /api/vehicle/list/all clamps an oversized limit to 100', async () => {
    const res = await request(app).get('/api/vehicle/list/all?limit=999999');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(MAX_LIMIT);
    expect(res.body.pagination.limit).toBe(MAX_LIMIT);
  });

  it('GET /api/vehicle/list/all with no limit param keeps the existing default of 10', async () => {
    const res = await request(app).get('/api/vehicle/list/all');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(10);
  });

  it('GET /api/vehicle/routes clamps an oversized limit to 100', async () => {
    const res = await request(app).get('/api/vehicle/routes?limit=999999');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(MAX_LIMIT);
  });

  it('GET /api/vehicle/routes with no limit/page param still returns the full list (unchanged default)', async () => {
    const res = await request(app).get('/api/vehicle/routes');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(SEED_COUNT);
  });

  it('GET /api/vehicle-reviews/vehicle/:id clamps an oversized limit to 100', async () => {
    const res = await request(app)
      .get(`/api/vehicle-reviews/vehicle/${vehicleForReviews._id}?limit=999999`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(MAX_LIMIT);
  });

  it('GET /api/vehicle-reviews/vehicle/:id with no limit/page param still returns the full list (unchanged default)', async () => {
    const res = await request(app)
      .get(`/api/vehicle-reviews/vehicle/${vehicleForReviews._id}`)
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(SEED_COUNT);
  });
});
