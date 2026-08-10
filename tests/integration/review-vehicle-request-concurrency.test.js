const request = require('supertest');
const app = require('../../src/server');
const Manager = require('../../src/models/Manager');
const SuperAdmin = require('../../src/models/SuperAdmin');
const Route = require('../../src/models/Route');
const Vehicle = require('../../src/models/Vehicle');
const ManagerVehicleRequest = require('../../src/models/ManagerVehicleRequest');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Issue #56: reviewVehicleRequest used to guard re-review only with a
// `status !== 'PENDING'` check on a plain findById-then-save, with no
// atomicity between the read and the write — two concurrent APPROVE calls
// for the same request could both pass that check before either wrote.
// Pre-fix, forcing this exact interleave produces one 200 and one 409 (the
// second call to actually finish incidentally catches the first one's
// half-applied work via the duplicate-vehicle check, not via anything that
// knows the request was already reviewed) — not the two-Vehicle-documents
// worst case the issue describes, but still proof the read/write gap is real.
//
// A plain Promise.all([review(), review()]) doesn't reliably reproduce this:
// against an in-memory Mongo, one call's whole chain of awaits routinely
// resolves before the other's handler even starts, so the race window never
// actually gets hit by chance. This test forces the interleave deterministically
// instead: it pauses the first review call right after the (fixed) code's
// atomic claim step — inside Route.findOne, the first DB call in the
// CREATE_VEHICLE_ACCOUNT branch — lets a second review call run to
// completion, then resumes the first. That is exactly the interleaving the
// issue describes, engineered on purpose rather than hoped for.

const stamp = Date.now();

const login = (identifier, password) =>
  request(app).post('/api/auth/login').send({ identifier, password });

let superAdminToken;
let manager;
let route;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const superAdmin = await SuperAdmin.create({
    name: 'Concurrency Admin',
    email: `sa-concurrency-${stamp}@t.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true,
    isActive: true
  });
  superAdminToken = (await login(superAdmin.email, 'P@ssw0rd!')).body.accessToken;

  manager = await Manager.create({
    name: 'Concurrency Manager',
    email: `mgr-concurrency-${stamp}@t.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true,
    isActive: true
  });

  route = await Route.create({
    routeId: `CONC-ROUTE-${stamp}`,
    routeName: 'Concurrency Route',
    source: 'A',
    destination: 'B',
    distance: 10,
    estimatedTime: 20,
    fare: 50,
    serviceType: 'PUBLIC',
    isActive: true
  });
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('PATCH /api/super-admin/vehicle-requests/:requestId/review — concurrent reviews', () => {
  it('only one of two interleaved APPROVE calls on the same request succeeds', async () => {
    const requestDoc = await ManagerVehicleRequest.create({
      type: 'CREATE_VEHICLE_ACCOUNT',
      managerId: manager._id,
      vehicleId: `CONC-VEH-${stamp}`,
      payload: {
        vehicle: {
          vehicleId: `CONC-VEH-${stamp}`,
          vehicleName: 'Concurrency Vehicle',
          numberPlate: `CNC-${stamp}`,
          routeId: route.routeId,
          vehicleType: 'AC',
          serviceType: 'PUBLIC'
        },
        driver: {
          name: 'Concurrency Driver',
          email: `drv-concurrency-${stamp}@t.com`,
          phoneNumber: '0761234567',
          password: 'P@ssw0rd!'
        }
      }
    });

    const review = () =>
      request(app)
        .patch(`/api/super-admin/vehicle-requests/${requestDoc._id}/review`)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send({ decision: 'APPROVE' });

    let releaseFirstCall;
    const paused = new Promise((resolve) => { releaseFirstCall = resolve; });

    const originalFindOne = Route.findOne.bind(Route);
    const spy = jest.spyOn(Route, 'findOne').mockImplementation(async (...args) => {
      spy.mockRestore(); // only the first call (from the paused request) pauses
      const secondResponse = await review();
      releaseFirstCall(secondResponse);
      return originalFindOne(...args);
    });

    const firstResponse = await review();
    const secondResponse = await paused;

    const statuses = [firstResponse.status, secondResponse.status].sort();

    // One call wins (200), the other loses the race with a clean 400 —
    // never two 200s, and never an unhandled 500 from a raw duplicate-key error.
    expect(statuses).toEqual([200, 400]);

    const vehicles = await Vehicle.find({ vehicleId: `CONC-VEH-${stamp}` });
    expect(vehicles).toHaveLength(1);

    const finalRequest = await ManagerVehicleRequest.findById(requestDoc._id);
    expect(finalRequest.status).toBe('APPROVED');
  });
});
