const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const Organization = require('../../src/models/Organization');
const DriverEnrollment = require('../../src/models/DriverEnrollment');
const Notification = require('../../src/models/Notification');
const { ensureDriverEnrollmentKey } = require('../../src/utils/enrollmentKey');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createRider, createDriver, authHeader } = require('./factories');

// Who is actually enrolled with a manager's drivers.
//
// The gap this file exists to close: a rider enrolling with a NON-private driver
// is written straight to ACTIVE (enrollmentController: `status = requiredApproval
// ? 'PENDING' : 'ACTIVE'`), so they never pass through the approval queue. The
// manager's only enrollment screen asked for PENDING, so those riders were
// invisible everywhere in the portal, and an approved rider vanished from the
// queue the moment they were approved. The roster answers "who rides with this
// driver", and removal is the manager-side counterpart to the rider leaving.

let manager;
let managerAuth;
let otherManager;
let otherManagerAuth;
let privateDriver;
let publicDriver;
let foreignDriver;
let parent;
let parentAuth;
let selfRiderId;
let addedRiderId;

// Enrol a rider through the real endpoint, so the row carries exactly what the
// app writes: a studentId, a null userId, and an organization profile.
async function enrol(riderId, key, responses = { grade: '6' }) {
  const res = await request(app)
    .post(`/api/enrollments/riders/${riderId}`)
    .set(...parentAuth)
    .send({ key, schemaVersion: 1, responses });
  expect([200, 201]).toContain(res.status);
  return res;
}

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  await Driver.syncIndexes();

  manager = await createManager({ name: 'Roster Manager' });
  managerAuth = authHeader(manager.token);
  otherManager = await createManager({ name: 'Foreign Manager' });
  otherManagerAuth = authHeader(otherManager.token);

  const organization = await Organization.create({
    name: `Roster College ${Date.now()}`,
    serviceType: 'SCHOOL',
    managerId: manager.id
  });

  const privateAccount = await createDriver({
    name: 'Private Driver',
    fields: { managerId: manager.id, isPrivate: true, organization: organization._id }
  });
  privateDriver = await Driver.findById(privateAccount.id);

  const publicAccount = await createDriver({
    name: 'Open Driver',
    fields: { managerId: manager.id, isPrivate: false, organization: organization._id }
  });
  publicDriver = await Driver.findById(publicAccount.id);

  const foreignAccount = await createDriver({
    name: 'Someone Elses Driver',
    fields: { managerId: otherManager.id, isPrivate: false, organization: organization._id }
  });
  foreignDriver = await Driver.findById(foreignAccount.id);

  parent = await createRider({ name: 'Parent Account', fields: { phoneNumber: '0771111111' } });
  parentAuth = authHeader(parent.token);

  const list = await request(app).get('/api/riders').set(...parentAuth);
  selfRiderId = list.body.data[0]._id;

  const added = await request(app)
    .post('/api/riders')
    .set(...parentAuth)
    .send({ fullName: 'Amaya', contactPhone: '0772222222' });
  addedRiderId = added.body.data._id;

  // The rider who never touches the queue: a non-private driver enrols ACTIVE.
  await enrol(selfRiderId, await ensureDriverEnrollmentKey(publicDriver._id), { grade: '11' });

  // The rider who does: private driver, so PENDING until approved.
  await enrol(addedRiderId, await ensureDriverEnrollmentKey(privateDriver._id), { grade: '6' });
});

afterAll(async () => {
  await closeTestDb();
});

describe('GET /api/manager/enrollment-requests?status=ACTIVE', () => {
  it('lists a rider of a non-private driver, who never entered the queue', async () => {
    const res = await request(app)
      .get('/api/manager/enrollment-requests?status=ACTIVE')
      .set(...managerAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);

    const [row] = res.body.data;
    expect(row.status).toBe('ACTIVE');
    expect(row.driver.name).toBe('Open Driver');
    expect(row.passenger.name).toBe('Parent Account');
    expect(row.passenger.riderCode).toBeTruthy();
    // The answers the rider typed, labelled the way the organization asked for them.
    expect(row.passenger.organizationDetails).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'grade', value: '11' })])
    );
  });

  it('keeps the pending rider out of the ACTIVE list', async () => {
    const res = await request(app)
      .get('/api/manager/enrollment-requests?status=PENDING')
      .set(...managerAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].driver.name).toBe('Private Driver');
  });

  it('narrows to one driver with ?driverId=', async () => {
    const res = await request(app)
      .get(`/api/manager/enrollment-requests?status=ACTIVE&driverId=${publicDriver._id}`)
      .set(...managerAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].driver._id).toBe(String(publicDriver._id));
  });

  it('returns an empty list for an owned driver with nobody enrolled', async () => {
    const res = await request(app)
      .get(`/api/manager/enrollment-requests?status=ACTIVE&driverId=${privateDriver._id}`)
      .set(...managerAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('404s on another manager\'s driver rather than revealing it exists', async () => {
    const res = await request(app)
      .get(`/api/manager/enrollment-requests?status=ACTIVE&driverId=${foreignDriver._id}`)
      .set(...managerAuth);

    expect(res.status).toBe(404);
  });

  it('shows a manager none of another manager\'s riders', async () => {
    const res = await request(app)
      .get('/api/manager/enrollment-requests?status=ACTIVE')
      .set(...otherManagerAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('401s without a token', async () => {
    const res = await request(app).get('/api/manager/enrollment-requests?status=ACTIVE');
    expect(res.status).toBe(401);
  });

  it('403s for a rider token', async () => {
    const res = await request(app)
      .get('/api/manager/enrollment-requests?status=ACTIVE')
      .set(...parentAuth);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/manager/drivers rider counts', () => {
  it('counts active and pending enrollments per driver', async () => {
    const res = await request(app).get('/api/manager/drivers').set(...managerAuth);

    expect(res.status).toBe(200);
    const byName = new Map(res.body.data.map((d) => [d.name, d]));
    expect(byName.get('Open Driver').riders).toEqual({ active: 1, pending: 0 });
    expect(byName.get('Private Driver').riders).toEqual({ active: 0, pending: 1 });
  });

  it('reports zero for a driver nobody has enrolled with', async () => {
    const res = await request(app).get('/api/manager/drivers').set(...otherManagerAuth);

    expect(res.status).toBe(200);
    const [driver] = res.body.data;
    expect(driver.riders).toEqual({ active: 0, pending: 0 });
  });
});

describe('DELETE /api/manager/enrollment-requests/:id', () => {
  let activeId;
  let pendingId;

  beforeEach(async () => {
    const active = await DriverEnrollment.findOne({ driverId: publicDriver._id, status: 'ACTIVE' });
    activeId = active ? String(active._id) : null;
    const pending = await DriverEnrollment.findOne({ driverId: privateDriver._id, status: 'PENDING' });
    pendingId = pending ? String(pending._id) : null;
  });

  it('409s on a pending request, which is declined rather than removed', async () => {
    const res = await request(app)
      .delete(`/api/manager/enrollment-requests/${pendingId}`)
      .set(...managerAuth);

    expect(res.status).toBe(409);
    expect(await DriverEnrollment.findById(pendingId)).not.toBeNull();
  });

  it('404s on another manager\'s enrollment', async () => {
    const res = await request(app)
      .delete(`/api/manager/enrollment-requests/${activeId}`)
      .set(...otherManagerAuth);

    expect(res.status).toBe(404);
    expect(await DriverEnrollment.findById(activeId)).not.toBeNull();
  });

  it('401s without a token', async () => {
    const res = await request(app).delete(`/api/manager/enrollment-requests/${activeId}`);
    expect(res.status).toBe(401);
  });

  it('403s for a rider token', async () => {
    const res = await request(app)
      .delete(`/api/manager/enrollment-requests/${activeId}`)
      .set(...parentAuth);
    expect(res.status).toBe(403);
  });

  // Last, because it is the one that actually removes the row.
  it('removes an active rider and tells them why', async () => {
    const res = await request(app)
      .delete(`/api/manager/enrollment-requests/${activeId}`)
      .set(...managerAuth);

    expect(res.status).toBe(200);
    expect(await DriverEnrollment.findById(activeId)).toBeNull();

    const notification = await Notification.findOne({
      studentId: selfRiderId,
      type: 'ROUTE_ACCESS_REVOKED'
    });
    expect(notification).not.toBeNull();

    // And the directory count follows it down.
    const drivers = await request(app).get('/api/manager/drivers').set(...managerAuth);
    const open = drivers.body.data.find((d) => d.name === 'Open Driver');
    expect(open.riders).toEqual({ active: 0, pending: 0 });
  });
});
