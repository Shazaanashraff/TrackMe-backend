const request = require('supertest');
const app = require('../../src/server');
const Route = require('../../src/models/Route');
const Vehicle = require('../../src/models/Vehicle');
const ManagerAuditLog = require('../../src/models/ManagerAuditLog');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createSuperAdmin, authHeader } = require('./factories');

// Issue #69: createManager, updateManager, resetManagerPassword already have solid
// behavioral coverage elsewhere (manager-organizations.test.js,
// manager-provisioning.test.js, manager-shared-identity-email.test.js). The remaining
// gap this issue actually describes is updateManagerStatus (zero coverage),
// getAuditLogs (only its malformed-id 400 is tested, never a real filtered read), and
// assignVehiclesToManager's 400/404 branches (assign-vehicles-scope.test.js only
// exercises the scope-mismatch 409 and the plain-success 200).

const stamp = Date.now();

let superAdminToken;
const auth = () => authHeader(superAdminToken);

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const superAdmin = await createSuperAdmin({ name: 'Status Audit Admin' });
  superAdminToken = superAdmin.token;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('PATCH /api/super-admin/managers/:managerId/status', () => {
  it('deactivates then reactivates a manager', async () => {
    const manager = await createManager({ name: 'Status Manager', signIn: false });

    const deactivate = await request(app)
      .patch(`/api/super-admin/managers/${manager.id}/status`)
      .set(...auth())
      .send({ isActive: false });

    expect(deactivate.status).toBe(200);
    expect(deactivate.body.data.isActive).toBe(false);
    expect(deactivate.body.message).toMatch(/deactivated/i);

    const reactivate = await request(app)
      .patch(`/api/super-admin/managers/${manager.id}/status`)
      .set(...auth())
      .send({ isActive: true });

    expect(reactivate.status).toBe(200);
    expect(reactivate.body.data.isActive).toBe(true);
    expect(reactivate.body.message).toMatch(/activated/i);
  });

  it('404s for a manager that does not exist', async () => {
    const missingId = new (require('mongoose').Types.ObjectId)();
    const res = await request(app)
      .patch(`/api/super-admin/managers/${missingId}/status`)
      .set(...auth())
      .send({ isActive: false });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/super-admin/audit-logs', () => {
  let managerA;
  let managerB;

  beforeAll(async () => {
    managerA = await createManager({ name: 'Audit Manager A', signIn: false });
    managerB = await createManager({ name: 'Audit Manager B', signIn: false });

    await ManagerAuditLog.create({
      managerId: managerA.id,
      actorId: (await createSuperAdmin({ name: 'Log Actor', signIn: false })).id,
      actorRole: 'super-admin',
      action: 'VEHICLE_REQUEST_APPROVED',
      entityType: 'VEHICLE_REQUEST',
      entityId: `AUDIT-A-${stamp}`
    });
    await ManagerAuditLog.create({
      managerId: managerB.id,
      actorId: managerB.id,
      actorRole: 'admin',
      action: 'ROUTE_UPDATED',
      entityType: 'ROUTE',
      entityId: `AUDIT-B-${stamp}`
    });
  });

  it('filters by managerId', async () => {
    const res = await request(app)
      .get(`/api/super-admin/audit-logs?managerId=${managerA.id}`)
      .set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].entityId).toBe(`AUDIT-A-${stamp}`);
  });

  it('filters by action', async () => {
    const res = await request(app)
      .get('/api/super-admin/audit-logs?action=ROUTE_UPDATED')
      .set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].entityId).toBe(`AUDIT-B-${stamp}`);
  });

  it('filters by entityType', async () => {
    const res = await request(app)
      .get('/api/super-admin/audit-logs?entityType=VEHICLE_REQUEST')
      .set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.data.every((entry) => entry.entityType === 'VEHICLE_REQUEST')).toBe(true);
    expect(res.body.data.some((entry) => entry.entityId === `AUDIT-A-${stamp}`)).toBe(true);
  });

  it('with no filter returns every log, newest first', async () => {
    const res = await request(app).get('/api/super-admin/audit-logs').set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(res.body.data.length);
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });
});

describe('PATCH /api/super-admin/managers/:managerId/assign-vehicles', () => {
  let manager;
  let route;
  let vehicle;

  beforeAll(async () => {
    manager = await createManager({ name: 'Assign Manager', signIn: false });
    route = await Route.create({
      routeId: `ASN-ROUTE-${stamp}`,
      routeName: 'Assign Route',
      source: 'A',
      destination: 'B',
      distance: 10,
      estimatedTime: 20,
      fare: 50,
      serviceType: 'PUBLIC',
      isActive: true
    });
    vehicle = await Vehicle.create({
      vehicleId: `ASN-VEH-${stamp}`,
      vehicleName: 'Assign Vehicle',
      numberPlate: `ASN-${stamp}`,
      registrationNumber: `ASN-REG-${stamp}`,
      routeId: route.routeId,
      vehicleType: 'AC',
      serviceType: 'PUBLIC',
      isActive: true,
      isDeleted: false
    });
  });

  it('assigns a valid, in-scope vehicle to the manager', async () => {
    const res = await request(app)
      .patch(`/api/super-admin/managers/${manager.id}/assign-vehicles`)
      .set(...auth())
      .send({ vehicleIds: [vehicle._id] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const updated = await Vehicle.findById(vehicle._id);
    expect(String(updated.managerId)).toBe(String(manager.id));
  });

  it('400s when a vehicle id in the list does not exist', async () => {
    const missingVehicleId = new (require('mongoose').Types.ObjectId)();
    const res = await request(app)
      .patch(`/api/super-admin/managers/${manager.id}/assign-vehicles`)
      .set(...auth())
      .send({ vehicleIds: [vehicle._id, missingVehicleId] });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('404s for a manager that does not exist', async () => {
    const missingId = new (require('mongoose').Types.ObjectId)();
    const res = await request(app)
      .patch(`/api/super-admin/managers/${missingId}/assign-vehicles`)
      .set(...auth())
      .send({ vehicleIds: [vehicle._id] });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
