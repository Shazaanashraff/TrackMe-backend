const request = require('supertest');
const app = require('../../src/server');
const SuperAdmin = require('../../src/models/SuperAdmin');
const Manager = require('../../src/models/Manager');
const Driver = require('../../src/models/Driver');
const Bus = require('../../src/models/Bus');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Deleting a manager is irreversible, so the endpoint is gated on the manager
// already being deactivated — the reversible step always comes first. Buses the
// manager owned are unassigned rather than deleted, so the fleet survives.

let superAdminToken;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';

  const superAdmin = await SuperAdmin.create({
    name: 'Super Admin',
    email: `sa-del-${Date.now()}@test.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true,
    isActive: true,
  });
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: superAdmin.email, password: 'P@ssw0rd!' });
  superAdminToken = res.body.accessToken;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

const auth = () => ['Authorization', `Bearer ${superAdminToken}`];

let seq = 0;
const makeManager = (isActive) =>
  Manager.create({
    name: 'Deletable Mgr',
    email: `del-mgr-${Date.now()}-${seq++}@t.com`,
    password: 'P@ssw0rd!',
    isActive,
  });

// A Bus needs a real driver, and busId/registrationNumber/numberPlate are unique.
const makeBusFor = async (managerId) => {
  const n = seq++;
  const driver = await Driver.create({
    name: `Driver ${n}`,
    email: `del-drv-${Date.now()}-${n}@t.com`,
    password: 'P@ssw0rd!',
  });
  return Bus.create({
    busId: `DEL-BUS-${Date.now()}-${n}`,
    busName: `Deletable Bus ${n}`,
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

  it('unassigns the deleted manager\'s buses instead of deleting them', async () => {
    const manager = await makeManager(false);
    const busA = await makeBusFor(manager._id);
    const busB = await makeBusFor(manager._id);

    const res = await request(app)
      .delete(`/api/super-admin/managers/${manager._id}`)
      .set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.data.unassignedBuses).toBe(2);

    // Buses survive, just detached from the deleted manager.
    const [afterA, afterB] = await Promise.all([
      Bus.findById(busA._id),
      Bus.findById(busB._id),
    ]);
    expect(afterA).not.toBeNull();
    expect(afterB).not.toBeNull();
    expect(afterA.managerId).toBeNull();
    expect(afterB.managerId).toBeNull();
  });

  it('leaves other managers and their buses untouched', async () => {
    const doomed = await makeManager(false);
    const bystander = await makeManager(false);
    const doomedBus = await makeBusFor(doomed._id);
    const bystanderBus = await makeBusFor(bystander._id);

    const res = await request(app)
      .delete(`/api/super-admin/managers/${doomed._id}`)
      .set(...auth());

    expect(res.status).toBe(200);
    expect(res.body.data.unassignedBuses).toBe(1);

    // The bystander must keep both their account and their bus assignment.
    expect(await Manager.findById(bystander._id)).not.toBeNull();
    const bystanderBusAfter = await Bus.findById(bystanderBus._id);
    expect(String(bystanderBusAfter.managerId)).toBe(String(bystander._id));

    const doomedBusAfter = await Bus.findById(doomedBus._id);
    expect(doomedBusAfter.managerId).toBeNull();
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
