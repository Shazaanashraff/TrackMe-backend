const request = require('supertest');
const app = require('../../src/server');
const Route = require('../../src/models/Route');
const Vehicle = require('../../src/models/Vehicle');
const Driver = require('../../src/models/Driver');
const ManagerVehicleRequest = require('../../src/models/ManagerVehicleRequest');
const ManagerAuditLog = require('../../src/models/ManagerAuditLog');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createSuperAdmin } = require('./factories');

// Issue #68: reviewVehicleRequest (superAdminController) is the highest-privilege
// super-admin endpoint — it creates Vehicle/Driver documents, deletes vehicles, and
// mints identities — yet only two of its branches had any test coverage (the
// concurrency guard in review-vehicle-request-concurrency.test.js and the field
// whitelist in review-vehicle-request-whitelist.test.js). This file rounds out the
// remaining branches: successful APPROVE/REJECT, the already-reviewed 400 guard, the
// request-not-found 404, the duplicate-vehicle 409, and the DELETE_VEHICLE approval
// path (including its own not-found 404).
//
// The issue's acceptance criteria was written against an older "Bus" naming and an
// approval flow with separate custom-route/existing-route sub-branches; both the
// Bus->Vehicle rename and the removal of custom routes (see issue #49's investigation
// notes) mean that split no longer exists in the current code — reviewVehicleRequest's
// CREATE_VEHICLE_ACCOUNT branch has one route lookup, not two. Tests below cover the
// branches as they exist on main today.

const stamp = Date.now();

let superAdminToken;
let superAdminId;
let manager;
let route;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const superAdmin = await createSuperAdmin({ name: 'Branches Admin' });
  superAdminToken = superAdmin.token;
  superAdminId = superAdmin.id;

  manager = await createManager({ name: 'Branches Manager', signIn: false });

  route = await Route.create({
    routeId: `BR-ROUTE-${stamp}`,
    routeName: 'Branches Route',
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

const review = (requestId, body) =>
  request(app)
    .patch(`/api/super-admin/vehicle-requests/${requestId}/review`)
    .set('Authorization', `Bearer ${superAdminToken}`)
    .send(body);

const createVehicleRequest = (overrides = {}) => ManagerVehicleRequest.create({
  type: 'CREATE_VEHICLE_ACCOUNT',
  managerId: manager.id,
  vehicleId: overrides.vehicleId,
  payload: {
    vehicle: {
      vehicleId: overrides.vehicleId,
      vehicleName: 'Branches Vehicle',
      numberPlate: `BR-${overrides.vehicleId}`,
      routeId: route.routeId,
      vehicleType: 'AC',
      serviceType: 'PUBLIC'
    },
    driver: {
      name: 'Branches Driver',
      email: overrides.driverEmail,
      phoneNumber: '0761234567',
      password: 'P@ssw0rd!'
    }
  },
  ...overrides.doc
});

describe('PATCH /api/super-admin/vehicle-requests/:requestId/review — remaining branches', () => {
  it('approves a CREATE_VEHICLE_ACCOUNT request: creates the vehicle, provisions the driver, and audit-logs it', async () => {
    const vehicleId = `BR-VEH-APPROVE-${stamp}`;
    const driverEmail = `drv-approve-${stamp}@t.com`;
    const requestDoc = await createVehicleRequest({ vehicleId, driverEmail });

    const res = await review(requestDoc._id, { decision: 'APPROVE' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('APPROVED');

    const vehicle = await Vehicle.findOne({ vehicleId });
    expect(vehicle).not.toBeNull();
    expect(String(vehicle.managerId)).toBe(String(manager.id));
    expect(vehicle.isDeleted).toBe(false);

    const driver = await Driver.findOne({ email: driverEmail });
    expect(driver).not.toBeNull();
    expect(driver.isActive).toBe(true);
    expect(String(vehicle.driverId)).toBe(String(driver._id));

    const finalRequest = await ManagerVehicleRequest.findById(requestDoc._id);
    expect(finalRequest.status).toBe('APPROVED');
    expect(String(finalRequest.decisionBy)).toBe(String(superAdminId));

    const auditEntry = await ManagerAuditLog.findOne({
      entityType: 'VEHICLE_REQUEST',
      entityId: requestDoc._id.toString(),
      action: 'VEHICLE_REQUEST_APPROVED'
    });
    expect(auditEntry).not.toBeNull();
  });

  it('rejects a request without touching the vehicle collection, and audit-logs the rejection', async () => {
    const vehicleId = `BR-VEH-REJECT-${stamp}`;
    const requestDoc = await createVehicleRequest({
      vehicleId,
      driverEmail: `drv-reject-${stamp}@t.com`
    });

    const res = await review(requestDoc._id, { decision: 'REJECT', note: 'Not needed' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('REJECTED');

    const vehicle = await Vehicle.findOne({ vehicleId });
    expect(vehicle).toBeNull();

    const finalRequest = await ManagerVehicleRequest.findById(requestDoc._id);
    expect(finalRequest.status).toBe('REJECTED');
    expect(finalRequest.decisionNote).toBe('Not needed');

    const auditEntry = await ManagerAuditLog.findOne({
      entityType: 'VEHICLE_REQUEST',
      entityId: requestDoc._id.toString(),
      action: 'VEHICLE_REQUEST_REJECTED'
    });
    expect(auditEntry).not.toBeNull();
  });

  it('400s a second review of a request that was already decided', async () => {
    const vehicleId = `BR-VEH-TWICE-${stamp}`;
    const requestDoc = await createVehicleRequest({
      vehicleId,
      driverEmail: `drv-twice-${stamp}@t.com`
    });

    const first = await review(requestDoc._id, { decision: 'REJECT' });
    expect(first.status).toBe(200);

    const second = await review(requestDoc._id, { decision: 'REJECT' });
    expect(second.status).toBe(400);
    expect(second.body.success).toBe(false);
  });

  it('404s reviewing a request id that does not exist', async () => {
    const missingId = new (require('mongoose').Types.ObjectId)();
    const res = await review(missingId, { decision: 'APPROVE' });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('409s approving a CREATE_VEHICLE_ACCOUNT request whose vehicleId already exists, and leaves the request reviewable', async () => {
    const vehicleId = `BR-VEH-DUP-${stamp}`;

    await Vehicle.create({
      vehicleId,
      vehicleName: 'Already Exists',
      numberPlate: `DUP-${stamp}`,
      registrationNumber: `DUP-REG-${stamp}`,
      routeId: route.routeId,
      vehicleType: 'AC',
      serviceType: 'PUBLIC',
      managerId: manager.id,
      isActive: true,
      isDeleted: false
    });

    const requestDoc = await createVehicleRequest({
      vehicleId,
      driverEmail: `drv-dup-${stamp}@t.com`
    });

    const res = await review(requestDoc._id, { decision: 'APPROVE' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);

    // The claim on PENDING status is released on this failure path so the
    // request can still be reviewed again rather than being stuck APPROVED
    // with nothing actually applied.
    const finalRequest = await ManagerVehicleRequest.findById(requestDoc._id);
    expect(finalRequest.status).toBe('PENDING');
  });

  describe('DELETE_VEHICLE requests', () => {
    it('approves a DELETE_VEHICLE request: soft-deletes the vehicle and deactivates its driver', async () => {
      const vehicleId = `BR-VEH-DELETE-${stamp}`;
      const driver = await Driver.create({
        name: 'To Be Orphaned',
        email: `drv-delete-${stamp}@t.com`,
        password: 'P@ssw0rd!',
        phoneNumber: '0761234567',
        isActive: true,
        isEmailVerified: true,
        managerId: manager.id
      });
      const vehicle = await Vehicle.create({
        vehicleId,
        vehicleName: 'Delete Me',
        numberPlate: `DEL-${stamp}`,
        registrationNumber: `DEL-REG-${stamp}`,
        routeId: route.routeId,
        vehicleType: 'AC',
        serviceType: 'PUBLIC',
        managerId: manager.id,
        driverId: driver._id,
        isActive: true,
        isDeleted: false
      });

      const requestDoc = await ManagerVehicleRequest.create({
        type: 'DELETE_VEHICLE',
        managerId: manager.id,
        vehicleId
      });

      const res = await review(requestDoc._id, { decision: 'APPROVE' });

      expect(res.status).toBe(200);

      const deletedVehicle = await Vehicle.findById(vehicle._id);
      expect(deletedVehicle.isDeleted).toBe(true);
      expect(deletedVehicle.isActive).toBe(false);

      const deactivatedDriver = await Driver.findById(driver._id);
      expect(deactivatedDriver.isActive).toBe(false);

      const auditEntry = await ManagerAuditLog.findOne({
        entityType: 'VEHICLE_REQUEST',
        entityId: requestDoc._id.toString(),
        action: 'VEHICLE_REQUEST_APPROVED'
      });
      expect(auditEntry).not.toBeNull();
    });

    it('404s approving a DELETE_VEHICLE request whose vehicle no longer exists, and leaves the request reviewable', async () => {
      const requestDoc = await ManagerVehicleRequest.create({
        type: 'DELETE_VEHICLE',
        managerId: manager.id,
        vehicleId: `BR-VEH-GONE-${stamp}`
      });

      const res = await review(requestDoc._id, { decision: 'APPROVE' });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);

      const finalRequest = await ManagerVehicleRequest.findById(requestDoc._id);
      expect(finalRequest.status).toBe('PENDING');
    });
  });
});
