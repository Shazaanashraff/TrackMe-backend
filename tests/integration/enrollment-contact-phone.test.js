const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const User = require('../../src/models/User');
const RiderProfile = require('../../src/models/RiderProfile');
const Organization = require('../../src/models/Organization');
const { ensureDriverEnrollmentKey } = require('../../src/utils/enrollmentKey');
const { ensureLegacyRider } = require('../../src/utils/riders');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createRider, authHeader } = require('./factories');

// Enrolment refuses without a valid contact phone, but the phone is not one of
// the organization's own `fields`. A client that rendered only `fields` could
// neither collect it nor know it was needed, so the sheet showed an error with
// nothing to type into. These lock the two halves of the fix: resolve says the
// phone is needed, and enrol accepts one.

const stamp = Date.now();

let managerId;
let passengerToken;
let passengerId;
let organizationId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';
  await Driver.syncIndexes();

  const manager = await createManager({ name: 'Fleet Manager' });
  managerId = manager.id;

  const passenger = await createRider({ name: 'Parent Account' });
  passengerToken = passenger.token;
  passengerId = passenger.id;

  const org = await Organization.create({
    name: 'Ananda College',
    serviceType: 'SCHOOL',
    managerId
  });
  organizationId = org._id;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

// The account starts with no phone at all, which is the state that produced the
// dead-end sheet.
beforeEach(async () => {
  await User.updateOne({ _id: passengerId }, { $set: { phoneNumber: '' } });
  await RiderProfile.updateMany({ accountId: passengerId }, { $set: { guardianPhoneOverride: '' } });
});

let seq = 0;
async function makeDriverWithKey() {
  seq += 1;
  const driver = await Driver.create({
    name: `Driver ${seq}`,
    driverCode: `DRV-CP${stamp % 1000}-${seq}`,
    password: 'P@ssw0rd!',
    managerId,
    organization: organizationId,
    isActive: true,
    isEmailVerified: true
  });
  return { driver, key: await ensureDriverEnrollmentKey(driver._id) };
}

// The organization's default schema has its own required field; supplying it
// keeps these tests about the contact phone rather than that.
const RESPONSES = { grade: '6' };

const asPassenger = () => authHeader(passengerToken);

const resolveKey = (key, riderId) =>
  request(app).post('/api/enrollments/resolve-key').set(...asPassenger()).send({ key, riderId });

const enrol = (riderId, body) =>
  request(app).post(`/api/enrollments/riders/${riderId}`).set(...asPassenger()).send(body);

// The profile is created lazily on first use, so go through the same helper the
// controllers do rather than assuming a row already exists.
const riderIdFor = async () => {
  const account = await User.findById(passengerId);
  return String((await ensureLegacyRider(account))._id);
};

describe('resolve-key tells the client a phone is needed', () => {
  test('flags contactPhoneRequired when the account has none', async () => {
    const { key } = await makeDriverWithKey();
    const riderId = await riderIdFor();

    const res = await resolveKey(key, riderId);

    expect(res.status).toBe(200);
    expect(res.body.data.contactPhoneRequired).toBe(true);
    expect(res.body.data.contactPhone).toBe('');
  });

  test('does not flag it once the account has a usable phone', async () => {
    await User.updateOne({ _id: passengerId }, { $set: { phoneNumber: '0771234567' } });
    const { key } = await makeDriverWithKey();
    const riderId = await riderIdFor();

    const res = await resolveKey(key, riderId);

    expect(res.body.data.contactPhoneRequired).toBe(false);
    expect(res.body.data.contactPhone).toBe('0771234567');
  });
});

describe('enrolling with a contact phone', () => {
  test('accepts a phone supplied with the enrolment and saves it to the rider', async () => {
    const { key } = await makeDriverWithKey();
    const riderId = await riderIdFor();

    const res = await enrol(riderId, { key, schemaVersion: 1, responses: RESPONSES, contactPhone: '0771234567' });

    expect(res.status).toBe(201);
    const rider = await RiderProfile.findById(riderId);
    expect(rider.guardianPhoneOverride).toBe('0771234567');
  });

  test('still refuses when no phone is supplied and none is stored', async () => {
    const { key } = await makeDriverWithKey();
    const riderId = await riderIdFor();

    const res = await enrol(riderId, { key, schemaVersion: 1, responses: RESPONSES });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONTACT_PHONE_REQUIRED');
  });

  test('rejects a malformed phone rather than storing it', async () => {
    const { key } = await makeDriverWithKey();
    const riderId = await riderIdFor();

    const res = await enrol(riderId, { key, schemaVersion: 1, responses: RESPONSES, contactPhone: 'abc' });

    expect(res.status).toBe(400);
    const rider = await RiderProfile.findById(riderId);
    expect(rider.guardianPhoneOverride).toBe('');
  });

  test('accepts the legacy guardianPhone field name too', async () => {
    const { key } = await makeDriverWithKey();
    const riderId = await riderIdFor();

    const res = await enrol(riderId, { key, schemaVersion: 1, responses: RESPONSES, guardianPhone: '0777654321' });

    expect(res.status).toBe(201);
  });

  // The account-level phone is enough on its own; the override exists for a
  // rider who needs a different contact from the account holder.
  test('needs no phone in the body when the account already has one', async () => {
    await User.updateOne({ _id: passengerId }, { $set: { phoneNumber: '0770000111' } });
    const { key } = await makeDriverWithKey();
    const riderId = await riderIdFor();

    const res = await enrol(riderId, { key, schemaVersion: 1, responses: RESPONSES });

    expect(res.status).toBe(201);
  });
});
