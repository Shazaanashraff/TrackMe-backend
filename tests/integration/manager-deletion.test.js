const request = require('supertest');
const app = require('../../src/server');
const Manager = require('../../src/models/Manager');
const Driver = require('../../src/models/Driver');
const Vehicle = require('../../src/models/Vehicle');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createSuperAdmin, authHeader } = require('./factories');

// Deleting a manager is irreversible, so the endpoint is gated on the manager
// already being deactivated — the reversible step always comes first. Vehicles the
// manager owned are unassigned rather than deleted, so the fleet survives.

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

let seq = 0;
const makeManager = (isActive) =>
  Manager.create({
    name: 'Deletable Mgr',
    email: `del-mgr-${Date.now()}-${seq++}@t.com`,
    password: 'P@ssw0rd!',
    isActive,
  });

// A Vehicle needs a real driver, and vehicleId/registrationNumber/numberPlate are unique.
const makeVehicleFor = async (managerId) => {
  const n = seq++;
  const driver = await Driver.create({
    name: `Driver ${n}`,
    email: `del-drv-${Date.now()}-${n}@t.com`,
    password: 'P@ssw0rd!',
  });
  return Vehicle.create({
    vehicleId: `DEL-VEHICLE-${Date.now()}-${n}`,
    vehicleName: `Deletable Vehicle ${n}`,
    registrationNumber: `DELREG-${Date.now()}-${n}`,
    numberPlate: `DEL-${Date.now()}-${n}`,
    routeId: 'DEL-ROUTE-1',
    driverId: driver._id,
    managerId,
    seatCapacity: 40,
  });
};

describe('DELETE /api/super-admin/managers/:managerId', () => {
  it('refuses to delete a manager that is still active', async () => {
    const manager = await makeManager(true);

    const res = await request(app)
      .delete(`/api/super-admin/managers/${manager._id}`)
      .set(...auth());

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/deactivate/i);
    // Still there — a refused delete must not be a partial delete.
    expect(await Manager.findById(manager._id)).not.toBeNull();
  });

  it('deletes a deactivated manager', async () => {
    const manager = await makeManager(false);

    const res = await request(app)
      .delete(`/api/super-admin/managers/${manager._id}`)
      .set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(await Manager.findById(manager._id)).toBeNull();
  });

  it('unassigns the deleted manager\'s vehicles instead of deleting them', async () => {
    const manager = await makeManager(false);
    const vehicleA = await makeVehicleFor(manager._id);
    const vehicleB = await makeVehicleFor(manager._id);

    const res = await request(app)
      .delete(`/api/super-admin/managers/${manager._id}`)
      .set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.data.unassignedVehicles).toBe(2);

    // Vehicles survive, just detached from the deleted manager.
    const [afterA, afterB] = await Promise.all([
      Vehicle.findById(vehicleA._id),
      Vehicle.findById(vehicleB._id),
    ]);
    expect(afterA).not.toBeNull();
    expect(afterB).not.toBeNull();
    expect(afterA.managerId).toBeNull();
    expect(afterB.managerId).toBeNull();
  });

  it('leaves other managers and their vehicles untouched', async () => {
    const doomed = await makeManager(false);
    const bystander = await makeManager(false);
    const doomedVehicle = await makeVehicleFor(doomed._id);
    const bystanderVehicle = await makeVehicleFor(bystander._id);

    const res = await request(app)
      .delete(`/api/super-admin/managers/${doomed._id}`)
      .set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.data.unassignedVehicles).toBe(1);

    // The bystander must keep both their account and their vehicle assignment.
    expect(await Manager.findById(bystander._id)).not.toBeNull();
    const bystanderVehicleAfter = await Vehicle.findById(bystanderVehicle._id);
    expect(String(bystanderVehicleAfter.managerId)).toBe(String(bystander._id));

    const doomedVehicleAfter = await Vehicle.findById(doomedVehicle._id);
    expect(doomedVehicleAfter.managerId).toBeNull();
  });

  it('returns 404 for a manager that does not exist', async () => {
    const manager = await makeManager(false);
    const id = manager._id;
    await Manager.deleteOne({ _id: id });

    const res = await request(app)
      .delete(`/api/super-admin/managers/${id}`)
      .set(...auth());

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('rejects an unauthenticated request', async () => {
    const manager = await makeManager(false);

    const res = await request(app).delete(`/api/super-admin/managers/${manager._id}`);

    expect(res.status).toBe(401);
    expect(await Manager.findById(manager._id)).not.toBeNull();
  });
});
