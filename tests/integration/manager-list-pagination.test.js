const request = require('supertest');
const app = require('../../src/server');
const Route = require('../../src/models/Route');
const ManagerVehicleRequest = require('../../src/models/ManagerVehicleRequest');
const RiderProfile = require('../../src/models/RiderProfile');
const BoardingEvent = require('../../src/models/BoardingEvent');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createRider, createDriver, authHeader } = require('./factories');

// Issue #64: none of the manager-facing list endpoints were paginated. The
// route-join-requests/route-members endpoints the issue also named no longer exist
// (private routes were removed — see issue #49/#74's investigation notes), so this
// covers the two that remain: getMyRequests (managerController) and
// getManagerAttendance (managerAttendanceController). Both reuse the existing
// opt-in pagination convention (superAdminController's getOperationsOverview /
// getPendingVehicleRequests): no page/limit param keeps returning the full,
// unbounded result exactly as before.

const stamp = Date.now();

let managerToken;
let manager;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  manager = await createManager({ name: 'Pagination Manager' });
  managerToken = manager.token;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

const auth = () => authHeader(managerToken);

describe('GET /api/manager/requests — pagination', () => {
  beforeAll(async () => {
    const docs = Array.from({ length: 15 }, (_, i) => ({
      type: 'DELETE_VEHICLE',
      managerId: manager.id,
      vehicleId: `PAG-REQ-${stamp}-${i}`
    }));
    await ManagerVehicleRequest.insertMany(docs);
  });

  it('returns the full unbounded list when no page/limit is given (unchanged default)', async () => {
    const res = await request(app).get('/api/manager/requests').set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.pagination).toBeUndefined();
    expect(res.body.data.length).toBe(15);
    expect(res.body.count).toBe(15);
  });

  it('paginates once page/limit is passed and reports pagination metadata', async () => {
    const res = await request(app).get('/api/manager/requests?page=2&limit=10').set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(5);
    expect(res.body.pagination).toEqual({ page: 2, limit: 10, total: 15, pages: 2 });
  });

  it('clamps an oversized requested limit to 100', async () => {
    const res = await request(app).get('/api/manager/requests?limit=999999').set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
    expect(res.body.data.length).toBe(15);
  });
});

describe('GET /api/manager/attendance — pagination', () => {
  beforeAll(async () => {
    const route = await Route.create({
      routeId: `PAG-ATT-ROUTE-${stamp}`,
      routeName: 'Pagination Attendance Route',
      source: 'A',
      destination: 'B',
      distance: 10,
      estimatedTime: 20,
      fare: 50,
      serviceType: 'PUBLIC',
      isActive: true,
      managerId: manager.id
    });

    const driver = await createDriver({ name: 'Pagination Driver', signIn: false });

    for (let i = 0; i < 12; i++) {
      const rider = await createRider({ name: `Pagination Rider ${i}`, signIn: false });
      const riderProfile = await RiderProfile.create({
        accountId: rider.id,
        riderCode: `PAGRC-${stamp}-${i}`,
        fullName: `Pagination Rider ${i}`
      });
      await BoardingEvent.create({
        studentId: riderProfile._id,
        vehicleId: `PAG-ATT-VEH-${stamp}`,
        routeId: route.routeId,
        driverId: driver.id,
        type: 'BOARD'
      });
    }
  });

  it('returns the full unbounded rollup when no page/limit is given (unchanged default)', async () => {
    const res = await request(app).get('/api/manager/attendance').set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.pagination).toBeUndefined();
    expect(res.body.data.length).toBe(12);
  });

  it('paginates once page/limit is passed and reports pagination metadata', async () => {
    const res = await request(app).get('/api/manager/attendance?page=2&limit=5').set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(5);
    expect(res.body.pagination).toEqual({ page: 2, limit: 5, total: 12, pages: 3 });
  });

  it('clamps an oversized requested limit to 100', async () => {
    const res = await request(app).get('/api/manager/attendance?limit=999999').set(...auth());
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
    expect(res.body.data.length).toBe(12);
  });
});
