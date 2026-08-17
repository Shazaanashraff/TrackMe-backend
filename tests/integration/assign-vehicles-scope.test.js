const request = require('supertest');
const app = require('../../src/server');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createSuperAdmin, createManager, authHeader } = require('./factories');
const Route = require('../../src/models/Route');
const Vehicle = require('../../src/models/Vehicle');
const Organization = require('../../src/models/Organization');

// Regression coverage for issue #80 — assignVehiclesToManager used to mass-reassign
// vehicles to a manager with no check against the manager's province/organization
// scope, letting a vehicle silently slip out from under the manager who actually
// operates it.
describe('PATCH /api/super-admin/managers/:managerId/assign-vehicles — scope check', () => {
  beforeAll(connectTestDb);
  afterEach(clearTestDb);
  afterAll(closeTestDb);

  const makeRoute = (overrides = {}) => Route.create({
    routeId: `RT-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    routeName: 'Test Route',
    source: 'A',
    destination: 'B',
    distance: 10,
    fare: 100,
    serviceType: 'PUBLIC',
    ...overrides
  });

  const makeVehicle = (overrides = {}) => Vehicle.create({
    vehicleId: `VH-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    vehicleName: 'Test Vehicle',
    registrationNumber: `REG-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    numberPlate: `NP-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    ...overrides
  });

  test('rejects assigning a vehicle whose route province differs from a PUBLIC manager province', async () => {
    const superAdmin = await createSuperAdmin();
    const manager = await createManager({ fields: { serviceType: 'PUBLIC', province: 'Western' } });

    const route = await makeRoute({ province: 'Southern' });
    const vehicle = await makeVehicle({ routeId: route.routeId });

    const res = await request(app)
      .patch(`/api/super-admin/managers/${manager.id}/assign-vehicles`)
      .set(...authHeader(superAdmin.token))
      .send({ vehicleIds: [vehicle._id.toString()] });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);

    const unchanged = await Vehicle.findById(vehicle._id);
    expect(unchanged.managerId).toBeNull();
  });

  test('allows assigning a vehicle whose route province matches a PUBLIC manager province', async () => {
    const superAdmin = await createSuperAdmin();
    const manager = await createManager({ fields: { serviceType: 'PUBLIC', province: 'Western' } });

    const route = await makeRoute({ province: 'Western' });
    const vehicle = await makeVehicle({ routeId: route.routeId });

    const res = await request(app)
      .patch(`/api/super-admin/managers/${manager.id}/assign-vehicles`)
      .set(...authHeader(superAdmin.token))
      .send({ vehicleIds: [vehicle._id.toString()] });

    expect(res.status).toBe(200);

    const updated = await Vehicle.findById(vehicle._id);
    expect(updated.managerId.toString()).toBe(manager.id.toString());
  });

  test('allows assigning a vehicle with no route yet to a PUBLIC manager', async () => {
    const superAdmin = await createSuperAdmin();
    const manager = await createManager({ fields: { serviceType: 'PUBLIC', province: 'Western' } });
    const vehicle = await makeVehicle();

    const res = await request(app)
      .patch(`/api/super-admin/managers/${manager.id}/assign-vehicles`)
      .set(...authHeader(superAdmin.token))
      .send({ vehicleIds: [vehicle._id.toString()] });

    expect(res.status).toBe(200);
  });

  test('rejects assigning a vehicle from a different organization to an OFFICE manager', async () => {
    const superAdmin = await createSuperAdmin();
    const orgA = await Organization.create({ name: 'Org A', serviceType: 'OFFICE' });
    const orgB = await Organization.create({ name: 'Org B', serviceType: 'OFFICE' });
    const manager = await createManager({ fields: { serviceType: 'OFFICE', organization: orgA._id } });
    const vehicle = await makeVehicle({ serviceType: 'OFFICE', organization: orgB._id });

    const res = await request(app)
      .patch(`/api/super-admin/managers/${manager.id}/assign-vehicles`)
      .set(...authHeader(superAdmin.token))
      .send({ vehicleIds: [vehicle._id.toString()] });

    expect(res.status).toBe(409);

    const unchanged = await Vehicle.findById(vehicle._id);
    expect(unchanged.managerId).toBeNull();
  });

  test('allows assigning a vehicle from the same organization to an OFFICE manager', async () => {
    const superAdmin = await createSuperAdmin();
    const org = await Organization.create({ name: 'Org A', serviceType: 'OFFICE' });
    const manager = await createManager({ fields: { serviceType: 'OFFICE', organization: org._id } });
    const vehicle = await makeVehicle({ serviceType: 'OFFICE', organization: org._id });

    const res = await request(app)
      .patch(`/api/super-admin/managers/${manager.id}/assign-vehicles`)
      .set(...authHeader(superAdmin.token))
      .send({ vehicleIds: [vehicle._id.toString()] });

    expect(res.status).toBe(200);

    const updated = await Vehicle.findById(vehicle._id);
    expect(updated.managerId.toString()).toBe(manager.id.toString());
  });
});
