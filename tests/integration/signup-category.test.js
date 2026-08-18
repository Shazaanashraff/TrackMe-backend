const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const Driver = require('../../src/models/Driver');
const Organization = require('../../src/models/Organization');
const RiderProfile = require('../../src/models/RiderProfile');
const { ensureDriverEnrollmentKey } = require('../../src/utils/enrollmentKey');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, createRider, authHeader, uniqueEmail } = require('./factories');

// The category a rider picks while creating their account, and what it is worth
// afterwards: it seeds their own rider row, it prefills the organization's
// enrolment form under the same field keys, and editing that row is the single
// write path that keeps the account's name and phone in step with it.

const stamp = Date.now();
let managerId;
let organizationId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';
  await Driver.syncIndexes();

  const manager = await createManager({ name: 'Category Manager' });
  managerId = manager.id;

  const org = await Organization.create({ name: `Royal College ${stamp}`, serviceType: 'SCHOOL', managerId });
  organizationId = org._id;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

const register = (body) => request(app).post('/api/auth/register').send({
  name: 'Nimal Perera',
  password: 'P@ssw0rd!',
  ...body
});

const riderOf = async (email) => {
  const account = await User.findOne({ email });
  return RiderProfile.findOne({ accountId: account._id });
};

describe('choosing a category while creating the account', () => {
  test('school stores the category and the grade on the rider it seeds', async () => {
    const email = uniqueEmail('school');
    const res = await register({ email, category: 'SCHOOL', details: { grade: '7' } });

    expect(res.status).toBe(201);
    const rider = await riderOf(email);
    expect(rider.category).toBe('SCHOOL');
    expect(rider.details.get('grade')).toBe('7');
    expect(rider.fullName).toBe('Nimal Perera');
  });

  test('university and office ask for nothing beyond the name', async () => {
    const uniEmail = uniqueEmail('uni');
    const officeEmail = uniqueEmail('office');

    expect((await register({ email: uniEmail, category: 'UNIVERSITY' })).status).toBe(201);
    expect((await register({ email: officeEmail, category: 'OFFICE' })).status).toBe(201);

    expect((await riderOf(uniEmail)).category).toBe('UNIVERSITY');
    expect((await riderOf(officeEmail)).category).toBe('OFFICE');
    expect((await riderOf(officeEmail)).details).toBeUndefined();
  });

  test('school without a grade is refused, and no account is left behind', async () => {
    const email = uniqueEmail('nograde');
    const res = await register({ email, category: 'SCHOOL', details: {} });

    expect(res.status).toBe(400);
    expect(res.body.errors).toMatchObject({ grade: 'Grade is required' });
    expect(await User.findOne({ email })).toBeNull();
  });

  test('a category outside the three is refused by the validator', async () => {
    const res = await register({ email: uniqueEmail('public'), category: 'PUBLIC' });
    expect(res.status).toBe(400);
  });

  test('a detail the category never asks for is refused rather than stored', async () => {
    const res = await register({ email: uniqueEmail('extra'), category: 'OFFICE', details: { grade: '7' } });
    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty('grade');
  });

  // An app build released before this shipped sends neither field. It must still
  // register; the category is collected on first launch instead.
  test('an older client that sends no category still registers', async () => {
    const email = uniqueEmail('legacy');
    expect((await register({ email })).status).toBe(201);
    expect((await riderOf(email)).category).toBeNull();
  });
});

describe('reading and editing the rider', () => {
  let passenger;
  let selfRiderId;
  let addedRiderId;

  beforeAll(async () => {
    passenger = await createRider({ name: 'Account Holder', fields: { phoneNumber: '0771111111' } });

    const list = await request(app).get('/api/riders').set(...authHeader(passenger.token));
    selfRiderId = list.body.data[0]._id;

    const added = await request(app)
      .post('/api/riders')
      .set(...authHeader(passenger.token))
      .send({ fullName: 'Sanduni', contactPhone: '0772222222', category: 'SCHOOL', details: { grade: '4' } });
    addedRiderId = added.body.data._id;
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ category: 'SCHOOL', details: { grade: '4' }, isSelf: false });
  });

  test('the account holder own record is marked isSelf', async () => {
    const list = await request(app).get('/api/riders').set(...authHeader(passenger.token));
    const self = list.body.data.find((rider) => rider._id === selfRiderId);
    expect(self.isSelf).toBe(true);
    expect(list.body.data.filter((rider) => rider.isSelf)).toHaveLength(1);
  });

  test('editing yourself updates the account, so the two cannot drift apart', async () => {
    const res = await request(app)
      .patch(`/api/riders/${selfRiderId}`)
      .set(...authHeader(passenger.token))
      .send({ fullName: 'Nimal K Perera', contactPhone: '0773333333', category: 'UNIVERSITY' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ fullName: 'Nimal K Perera', contactPhone: '0773333333', category: 'UNIVERSITY' });

    const account = await User.findById(passenger.id);
    expect(account.name).toBe('Nimal K Perera');
    expect(account.phoneNumber).toBe('0773333333');
    // The phone lives on the account for this rider, not as an override.
    expect((await RiderProfile.findById(selfRiderId)).guardianPhoneOverride).toBe('');
  });

  test('editing someone you added leaves the account alone', async () => {
    const res = await request(app)
      .patch(`/api/riders/${addedRiderId}`)
      .set(...authHeader(passenger.token))
      .send({ fullName: 'Sanduni Perera', contactPhone: '0774444444' });

    expect(res.status).toBe(200);
    const account = await User.findById(passenger.id);
    expect(account.name).toBe('Nimal K Perera');
    expect(account.phoneNumber).toBe('0773333333');
    expect((await RiderProfile.findById(addedRiderId)).guardianPhoneOverride).toBe('0774444444');
  });

  test('a detail outside the category is refused on edit too', async () => {
    const res = await request(app)
      .patch(`/api/riders/${addedRiderId}`)
      .set(...authHeader(passenger.token))
      .send({ category: 'OFFICE', details: { grade: '5' } });

    expect(res.status).toBe(400);
    expect((await RiderProfile.findById(addedRiderId)).category).toBe('SCHOOL');
  });
});

describe('the signup answer prefills the organization form', () => {
  let passengerToken;
  let riderId;
  let key;

  beforeAll(async () => {
    const driver = await Driver.create({
      name: 'School Driver',
      driverCode: `DRV-SC${stamp % 1000}`,
      password: 'P@ssw0rd!',
      managerId,
      organization: organizationId,
      isActive: true,
      isEmailVerified: true
    });
    key = await ensureDriverEnrollmentKey(driver._id);

    const passenger = await createRider({ name: 'School Rider', fields: { phoneNumber: '0775555555' } });
    passengerToken = passenger.token;

    const list = await request(app).get('/api/riders').set(...authHeader(passengerToken));
    riderId = list.body.data[0]._id;
    await request(app)
      .patch(`/api/riders/${riderId}`)
      .set(...authHeader(passengerToken))
      .send({ category: 'SCHOOL', details: { grade: '7' } });
  });

  const resolveKey = () => request(app)
    .post('/api/enrollments/resolve-key')
    .set(...authHeader(passengerToken))
    .send({ key, riderId });

  test('the grade from signup comes back as a prefilled value, with the field still asked', async () => {
    const res = await resolveKey();

    expect(res.status).toBe(200);
    expect(res.body.data.existingValues).toMatchObject({ grade: '7' });
    expect(res.body.data.fields.map((field) => field.key)).toContain('grade');
  });

  test('what the rider told this organization wins over the signup answer', async () => {
    const enrolled = await request(app)
      .post(`/api/enrollments/riders/${riderId}`)
      .set(...authHeader(passengerToken))
      .send({ key, schemaVersion: 1, responses: { grade: '9' } });
    expect(enrolled.status).toBe(201);

    const res = await resolveKey();
    expect(res.body.data.existingValues.grade).toBe('9');
    // The rider's own answer is untouched: it belongs to them, not to the school.
    expect((await RiderProfile.findById(riderId)).details.get('grade')).toBe('7');
  });
});
