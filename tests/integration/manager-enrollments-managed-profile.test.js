const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const Driver = require('../../src/models/Driver');
const DriverEnrollment = require('../../src/models/DriverEnrollment');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createRider, createDriver, authHeader } = require('./factories');

// driver-enrollment.test.js locks the base passenger shape. This covers what
// changes for a managed profile: it has no email of its own, so the manager
// deciding a request needs the owning account's email/phone surfaced instead
// — otherwise the queue shows a bare name with no way to tell whose child it
// is. See docs/modules/PROFILES.md and managerEnrollmentsController.js.

let manager;
let managerAuth;
let driver;
let parent;
let child;

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

beforeEach(async () => {
  await clearTestDb();

  manager = await createManager({ name: 'Fleet Manager' });
  managerAuth = authHeader(manager.token);

  const driverAccount = await createDriver({ name: 'School Driver', fields: { managerId: manager.id, isPrivate: true } });
  driver = await Driver.findById(driverAccount.id);

  parent = await createRider({ name: 'Parent Account' });
  child = await User.create({
    name: 'Amaya', identityId: parent.identity._id, profileKind: 'MANAGED', relation: 'Daughter'
  });

  await DriverEnrollment.create({
    userId: child._id, driverId: driver._id, managerId: manager.id, status: 'PENDING', requiredApproval: true
  });
});

describe('GET /api/manager/enrollment-requests — managed profile visibility', () => {
  it("surfaces the owning account's email and phone for a managed passenger", async () => {
    const res = await request(app).get('/api/manager/enrollment-requests').set(...managerAuth);

    expect(res.status).toBe(200);
    const row = res.body.data.find((r) => r.passenger._id === String(child._id));

    expect(row.passenger.name).toBe('Amaya');
    expect(row.passenger.relation).toBe('Daughter');
    expect(row.passenger.isManagedProfile).toBe(true);
    // The pre-existing email column keeps working — falls back to the account's.
    expect(row.passenger.email).toBe(parent.email);
    expect(row.passenger.account).toMatchObject({
      name: 'Parent Account', email: parent.email, phoneNumber: parent.doc.phoneNumber || ''
    });
  });

  it('a PRIMARY passenger is its own account — no change from before', async () => {
    await DriverEnrollment.create({
      userId: parent.id, driverId: driver._id, managerId: manager.id, status: 'PENDING', requiredApproval: true
    });

    const res = await request(app).get('/api/manager/enrollment-requests').set(...managerAuth);
    const row = res.body.data.find((r) => r.passenger._id === String(parent.id));

    expect(row.passenger.isManagedProfile).toBe(false);
    expect(row.passenger.email).toBe(parent.email);
    expect(row.passenger.account.email).toBe(parent.email);
  });
});

describe('POST /api/manager/enrollment-requests/:id/approve — managed profile visibility', () => {
  it('the approval response also carries the account details', async () => {
    const pending = await DriverEnrollment.findOne({ userId: child._id });

    const res = await request(app)
      .post(`/api/manager/enrollment-requests/${pending._id}/approve`)
      .set(...managerAuth);

    expect(res.status).toBe(200);
    expect(res.body.data.passenger.account.email).toBe(parent.email);
    expect(res.body.data.passenger.isManagedProfile).toBe(true);
  });
});
