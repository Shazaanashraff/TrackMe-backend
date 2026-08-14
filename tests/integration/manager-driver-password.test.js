const crypto = require('crypto');
const request = require('supertest');
const app = require('../../src/server');
const Driver = require('../../src/models/Driver');
const ManagerAuditLog = require('../../src/models/ManagerAuditLog');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createManager, authHeader } = require('./factories');

// Viewing a driver's password in the clear. This is the one place the system
// gives back a credential, so the cases that matter are the boundaries: who is
// refused, what happens with the feature off, and whether the read is recorded.

const RECOVERY_KEY = crypto.randomBytes(32).toString('hex');

let managerToken;
let otherManagerToken;
let originalKey;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';
  originalKey = process.env.DRIVER_PASSWORD_KEY;
  process.env.DRIVER_PASSWORD_KEY = RECOVERY_KEY;
  await Driver.syncIndexes();

  const manager = await createManager({ name: 'Fleet Manager' });
  managerToken = manager.token;

  const other = await createManager({ name: 'Rival Manager' });
  otherManagerToken = other.token;
});

afterAll(async () => {
  if (originalKey === undefined) delete process.env.DRIVER_PASSWORD_KEY;
  else process.env.DRIVER_PASSWORD_KEY = originalKey;
  await clearTestDb();
  await closeTestDb();
});

let seq = 0;
const createDriver = (token, password = 'DriverPass1!') =>
  request(app)
    .post('/api/manager/drivers')
    .set(...authHeader(token))
    .send({
      name: 'Kamal Perera',
      email: `pw-${Date.now()}-${seq++}@t.com`,
      password,
      phoneNumber: '0771234567'
    });

const viewPassword = (token, driverId) =>
  request(app).get(`/api/manager/drivers/${driverId}/password`).set(...authHeader(token));

describe('GET /api/manager/drivers/:driverId/password', () => {
  test('returns the password the manager set at creation', async () => {
    const created = await createDriver(managerToken, 'SetAtCreation1!');
    expect(created.status).toBe(201);

    const res = await viewPassword(managerToken, created.body.data._id);

    expect(res.status).toBe(200);
    expect(res.body.data.password).toBe('SetAtCreation1!');
  });

  test('reflects a reset, so it never shows a password that no longer works', async () => {
    const created = await createDriver(managerToken, 'Original1!');
    const driverId = created.body.data._id;

    await request(app)
      .put(`/api/manager/drivers/${driverId}/password`)
      .set(...authHeader(managerToken))
      .send({ password: 'Rotated2!' });

    const res = await viewPassword(managerToken, driverId);
    expect(res.body.data.password).toBe('Rotated2!');
  });

  // The authorization boundary. A manager reaching another manager's driver
  // here would be handing out a working credential, not just leaking a name.
  test('refuses another manager’s driver', async () => {
    const created = await createDriver(managerToken, 'NotYours1!');

    const res = await viewPassword(otherManagerToken, created.body.data._id);

    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('NotYours1!');
  });

  test('refuses an unauthenticated caller', async () => {
    const created = await createDriver(managerToken);
    const res = await request(app).get(`/api/manager/drivers/${created.body.data._id}/password`);
    expect([401, 403]).toContain(res.status);
  });

  test('records every successful read in the audit log', async () => {
    const created = await createDriver(managerToken, 'Audited1!');
    const driverId = created.body.data._id;

    await viewPassword(managerToken, driverId);

    const entries = await ManagerAuditLog.find({
      action: 'DRIVER_PASSWORD_VIEWED',
      entityId: String(driverId)
    }).lean();
    expect(entries).toHaveLength(1);
    // The trail must never itself become a second copy of the password.
    expect(JSON.stringify(entries[0])).not.toContain('Audited1!');
  });

  test('404s for a driver stored before the feature existed', async () => {
    const created = await createDriver(managerToken);
    const driverId = created.body.data._id;
    await Driver.updateOne({ _id: driverId }, { $unset: { passwordRecoverable: '' } });

    const res = await viewPassword(managerToken, driverId);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PASSWORD_NOT_RECOVERABLE');
  });
});

describe('with the feature switched off', () => {
  test('503s rather than pretending the password is missing', async () => {
    const created = await createDriver(managerToken, 'Hidden1!');
    const driverId = created.body.data._id;

    delete process.env.DRIVER_PASSWORD_KEY;
    try {
      const res = await viewPassword(managerToken, driverId);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('PASSWORD_RECOVERY_DISABLED');
      expect(JSON.stringify(res.body)).not.toContain('Hidden1!');
    } finally {
      process.env.DRIVER_PASSWORD_KEY = RECOVERY_KEY;
    }
  });
});

describe('storage', () => {
  test('never returns the ciphertext on an ordinary driver read', async () => {
    await createDriver(managerToken, 'Secret1!');

    const list = await request(app).get('/api/manager/drivers').set(...authHeader(managerToken));

    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('passwordRecoverable');
    expect(JSON.stringify(list.body)).not.toContain('Secret1!');
  });

  test('stores the password encrypted, not in plaintext', async () => {
    const created = await createDriver(managerToken, 'Plaintext1!');

    const row = await Driver.findById(created.body.data._id)
      .select('+passwordRecoverable +password')
      .lean();

    expect(row.passwordRecoverable).toEqual(expect.stringMatching(/^v1:/));
    expect(row.passwordRecoverable).not.toContain('Plaintext1!');
    // Authentication still runs off the bcrypt hash, untouched by any of this.
    expect(row.password).toEqual(expect.stringMatching(/^\$2[aby]\$/));
  });
});
