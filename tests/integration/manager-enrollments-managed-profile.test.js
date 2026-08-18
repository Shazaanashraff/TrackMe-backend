const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const Organization = require('../../src/models/Organization');
const DriverEnrollment = require('../../src/models/DriverEnrollment');
const { ensureDriverEnrollmentKey } = require('../../src/utils/enrollmentKey');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createRider, createDriver, authHeader } = require('./factories');

// What the manager's approval queue shows about the person asking to join.
//
// The regression this file exists to prevent: the queue used to look passengers
// up by `DriverEnrollment.userId`, which the rider-profile enrolment path writes
// as null — so every request made by the current app reached the manager as
// `passenger: null`, with no name, no account and none of the answers the rider
// had just typed into the organization's form. The owner is `studentId`
// (a RiderProfile); see docs/modules/PROFILES.md.

let manager;
let managerAuth;
let driver;
let key;
let parent;
let parentAuth;
let selfRiderId;
let addedRiderId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  await Driver.syncIndexes();

  manager = await createManager({ name: 'Fleet Manager' });
  managerAuth = authHeader(manager.token);

  const organization = await Organization.create({
    name: `Ananda College ${Date.now()}`,
    serviceType: 'SCHOOL',
    managerId: manager.id
  });

  const driverAccount = await createDriver({
    name: 'School Driver',
    fields: { managerId: manager.id, isPrivate: true, organization: organization._id }
  });
  driver = await Driver.findById(driverAccount.id);
  key = await ensureDriverEnrollmentKey(driver._id);

  parent = await createRider({ name: 'Parent Account', fields: { phoneNumber: '0771111111' } });
  parentAuth = authHeader(parent.token);

  // The account holder's own rider row, created the way the app creates it.
  const list = await request(app).get('/api/riders').set(...parentAuth);
  selfRiderId = list.body.data[0]._id;

  const added = await request(app)
    .post('/api/riders')
    .set(...parentAuth)
    .send({ fullName: 'Amaya', contactPhone: '0772222222' });
  addedRiderId = added.body.data._id;

  // Both go through the real enrolment endpoint, so the rows carry exactly what
  // the app writes: a studentId, a null userId, and an organization profile.
  for (const [riderId, grade] of [[addedRiderId, '6'], [selfRiderId, '11']]) {
    const res = await request(app)
      .post(`/api/enrollments/riders/${riderId}`)
      .set(...parentAuth)
      .send({ key, schemaVersion: 1, responses: { grade } });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING');
  }
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

const queue = () => request(app).get('/api/manager/enrollment-requests').set(...managerAuth);

describe('GET /api/manager/enrollment-requests — who the request is for', () => {
  test('a request made through the rider path names the rider instead of nobody', async () => {
    const res = await queue();

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    // The regression: every one of these used to be null.
    expect(res.body.data.every((row) => row.passenger)).toBe(true);

    const row = res.body.data.find((r) => String(r.passenger._id) === String(addedRiderId));
    expect(row.passenger.name).toBe('Amaya');
    expect(row.passenger.riderCode).toMatch(/^TMR-/);
  });

  test("someone the account holder added carries the owning account's details", async () => {
    const res = await queue();
    const row = res.body.data.find((r) => String(r.passenger._id) === String(addedRiderId));

    expect(row.passenger.isManagedProfile).toBe(true);
    // The pre-existing email column keeps working — it falls back to the account's.
    expect(row.passenger.email).toBe(parent.email);
    expect(row.passenger.account).toMatchObject({
      name: 'Parent Account', email: parent.email, phoneNumber: '0771111111'
    });
    // Their own contact number, which is not the account holder's.
    expect(row.passenger.contactPhone).toBe('0772222222');
  });

  test('the account holder riding themselves is not marked as a managed profile', async () => {
    const res = await queue();
    const row = res.body.data.find((r) => String(r.passenger._id) === String(selfRiderId));

    expect(row.passenger.isManagedProfile).toBe(false);
    expect(row.passenger.email).toBe(parent.email);
    expect(row.passenger.account.email).toBe(parent.email);
  });

  test("the organization's own answers reach the manager deciding the request", async () => {
    const res = await queue();

    const added = res.body.data.find((r) => String(r.passenger._id) === String(addedRiderId));
    const self = res.body.data.find((r) => String(r.passenger._id) === String(selfRiderId));
    expect(added.passenger.organizationValues).toEqual({ grade: '6' });
    expect(self.passenger.organizationValues).toEqual({ grade: '11' });
  });
});

describe('POST /api/manager/enrollment-requests/:id/approve — the decision response', () => {
  test('the approval response carries the same rider, account and answers', async () => {
    const pending = await DriverEnrollment.findOne({ studentId: addedRiderId });

    const res = await request(app)
      .post(`/api/manager/enrollment-requests/${pending._id}/approve`)
      .set(...managerAuth);

    expect(res.status).toBe(200);
    expect(res.body.data.passenger.name).toBe('Amaya');
    expect(res.body.data.passenger.isManagedProfile).toBe(true);
    expect(res.body.data.passenger.account.email).toBe(parent.email);
    expect(res.body.data.passenger.organizationValues).toEqual({ grade: '6' });
  });
});
