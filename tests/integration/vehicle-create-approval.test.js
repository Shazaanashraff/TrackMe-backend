const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const Vehicle = require('../../src/models/Vehicle');
const Route = require('../../src/models/Route');
const ManagerVehicleRequest = require('../../src/models/ManagerVehicleRequest');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createSuperAdmin, authHeader } = require('./factories');

// A manager's first vehicle is still created outright (see
// manager-vehicle-create.test.js) — a brand new manager must never be stuck with
// an empty fleet and no way to fill it. Every vehicle after that now raises a
// CREATE_VEHICLE_ACCOUNT request a super admin must approve, mirroring how
// DELETE_VEHICLE already works. The approval branch itself pre-dates this
// change but was never reachable from any manager-facing endpoint, and had two
// bugs fixed here as part of wiring it up: an approved driver got no managerId
// (invisible in the manager's own directory), and an email already on another
// manager's driver could be reused with a new password (account hijack).

let superAdminToken;
let routeId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  const superAdmin = await createSuperAdmin({ name: 'Vehicle Approval Admin' });
  superAdminToken = superAdmin.token;

  const route = await Route.create({
    routeId: `VCA-R-${Date.now()}`,
    routeName: 'Approval Test Route',
    source: 'Colombo',
    destination: 'Matara',
    distance: 160,
    fare: 300,
    estimatedTime: 150
  });
  routeId = route.routeId;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

let seq = 0;
const vehicleBody = (overrides = {}) => ({
  vehicleId: `VCA-${Date.now()}-${seq}`,
  vehicleName: 'Approval Shuttle',
  numberPlate: `CAB-${6000 + seq++}`,
  routeId,
  seatCapacity: 30,
  ...overrides
});

// Gets a manager past the bootstrap slot: their first vehicle is created
// immediately, so every test below that needs to exercise the request/approval
// path starts from a manager who already owns one.
async function managerWithOneVehicle() {
  const manager = await createManager({ name: 'Fleet Grower' });
  const auth = authHeader(manager.token);
  const first = await request(app).post('/api/manager/vehicle-accounts').set(...auth).send(vehicleBody());
  expect(first.status).toBe(201);
  expect(first.body.data.vehicle).toBeTruthy();
  return { managerId: manager.id, managerToken: manager.token, auth };
}

describe('POST /api/manager/vehicle-accounts — bootstrap rule', () => {
  it('creates a brand new manager\'s first vehicle immediately, no request raised', async () => {
    const manager = await createManager({ name: 'Brand New Owner' });
    const body = vehicleBody();

    const res = await request(app).post('/api/manager/vehicle-accounts')
      .set(...authHeader(manager.token)).send(body);

    expect(res.status).toBe(201);
    expect(res.body.data.vehicle.vehicleId).toBe(body.vehicleId);
    expect(await ManagerVehicleRequest.countDocuments({ vehicleId: body.vehicleId })).toBe(0);
  });

  it('raises a pending CREATE_VEHICLE_ACCOUNT request for a second vehicle instead of creating it', async () => {
    const { auth, managerId } = await managerWithOneVehicle();
    const body = vehicleBody({ driverName: 'Second Vehicle Driver', password: 'DriverPass1!' });

    const res = await request(app).post('/api/manager/vehicle-accounts').set(...auth).send(body);

    expect(res.status).toBe(201);
    expect(res.body.data.vehicle).toBeUndefined();
    expect(res.body.data.type).toBe('CREATE_VEHICLE_ACCOUNT');
    expect(res.body.data.status).toBe('PENDING');
    expect(String(res.body.data.managerId)).toBe(String(managerId));

    expect(await Vehicle.findOne({ vehicleId: body.vehicleId })).toBeNull();
  });

  it('refuses a second pending request for the same vehicle ID', async () => {
    const { auth } = await managerWithOneVehicle();
    const body = vehicleBody();

    const first = await request(app).post('/api/manager/vehicle-accounts').set(...auth).send(body);
    expect(first.status).toBe(201);
    expect(first.body.data.status).toBe('PENDING');

    const again = await request(app).post('/api/manager/vehicle-accounts').set(...auth).send(body);
    expect(again.status).toBe(409);
  });
});

describe('PATCH /api/super-admin/vehicle-requests/:id/review — CREATE_VEHICLE_ACCOUNT', () => {
  it('creates the vehicle and a correctly-owned driver once approved', async () => {
    const { auth, managerId } = await managerWithOneVehicle();
    const driverEmail = `vca-drv-${Date.now()}@t.com`;
    const body = vehicleBody({
      driverName: 'Approved Driver', driverEmail, password: 'DriverPass1!'
    });

    const reqRes = await request(app).post('/api/manager/vehicle-accounts').set(...auth).send(body);
    expect(reqRes.status).toBe(201);
    const requestId = reqRes.body.data._id;

    const reviewRes = await request(app)
      .patch(`/api/super-admin/vehicle-requests/${requestId}/review`)
      .set(...authHeader(superAdminToken))
      .send({ decision: 'APPROVE' });
    expect(reviewRes.status).toBe(200);

    const vehicle = await Vehicle.findOne({ vehicleId: body.vehicleId });
    expect(vehicle).not.toBeNull();
    expect(String(vehicle.managerId)).toBe(String(managerId));

    const driver = await Driver.findById(vehicle.driverId);
    expect(driver).not.toBeNull();
    // Without this the approved driver would never show up in the manager's
    // own directory — the bug the dormant approval branch had before this fix.
    expect(String(driver.managerId)).toBe(String(managerId));

    const list = await request(app).get('/api/manager/drivers').set(...auth);
    expect(list.body.data.some((d) => String(d._id) === String(driver._id))).toBe(true);
  });

  it('leaves the vehicle uncreated when the request is rejected', async () => {
    const { auth } = await managerWithOneVehicle();
    const body = vehicleBody();

    const reqRes = await request(app).post('/api/manager/vehicle-accounts').set(...auth).send(body);
    const requestId = reqRes.body.data._id;

    const reviewRes = await request(app)
      .patch(`/api/super-admin/vehicle-requests/${requestId}/review`)
      .set(...authHeader(superAdminToken))
      .send({ decision: 'REJECT', note: 'Not needed yet' });
    expect(reviewRes.status).toBe(200);
    expect(reviewRes.body.data.status).toBe('REJECTED');

    expect(await Vehicle.findOne({ vehicleId: body.vehicleId })).toBeNull();
  });

  it('refuses to approve a request whose driver email was claimed by another manager after it was submitted (regression)', async () => {
    // The request-creation endpoint already refuses a driver email owned by
    // someone else at submit time (see manager-vehicle-create.test.js), so to
    // exercise the approval branch's *own* guard this simulates the request
    // racing ahead of a conflicting driver: the email is free when the manager
    // submits, and only claimed by another manager afterward, before a super
    // admin reviews it.
    const driverEmail = `vca-toctou-${Date.now()}@t.com`;
    const { auth } = await managerWithOneVehicle();
    const body = vehicleBody({
      driverName: 'Hijack Attempt', driverEmail, password: 'NewPass1!'
    });

    const reqRes = await request(app).post('/api/manager/vehicle-accounts').set(...auth).send(body);
    expect(reqRes.status).toBe(201);
    expect(reqRes.body.data.status).toBe('PENDING');
    const requestId = reqRes.body.data._id;

    const other = await createManager({ name: 'Other Fleet Owner', signIn: false });
    const theirs = await Driver.create({
      name: 'Theirs', email: driverEmail, password: 'OriginalPass1!', managerId: other.id
    });

    const reviewRes = await request(app)
      .patch(`/api/super-admin/vehicle-requests/${requestId}/review`)
      .set(...authHeader(superAdminToken))
      .send({ decision: 'APPROVE' });

    expect(reviewRes.status).toBe(409);
    expect(await Vehicle.findOne({ vehicleId: body.vehicleId })).toBeNull();

    const reloadedTheirs = await Driver.findById(theirs._id).select('+password');
    expect(String(reloadedTheirs.managerId)).toBe(String(other.id));
    expect(await reloadedTheirs.comparePassword('OriginalPass1!')).toBe(true);

    // The claim is released so the request stays reviewable, not stuck mid-review.
    const reloadedRequest = await ManagerVehicleRequest.findById(requestId);
    expect(reloadedRequest.status).toBe('PENDING');
  });

  it('refuses a manager (not a super admin) reviewing a request', async () => {
    const { auth } = await managerWithOneVehicle();
    const body = vehicleBody();
    const reqRes = await request(app).post('/api/manager/vehicle-accounts').set(...auth).send(body);
    const requestId = reqRes.body.data._id;

    const res = await request(app)
      .patch(`/api/super-admin/vehicle-requests/${requestId}/review`)
      .set(...auth)
      .send({ decision: 'APPROVE' });

    expect(res.status).toBe(403);
  });
});
