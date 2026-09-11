const request = require('supertest');
const app = require('../../src/server');
const RiderProfile = require('../../src/models/RiderProfile');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createRider, authHeader } = require('./factories');

describe('neutral rider profile API', () => {
  let token;
  let accountId;

  beforeAll(async () => {
    await connectTestDb();
    await clearTestDb();
    const account = await createRider({ name: 'Account Holder', fields: { phoneNumber: '0771111111' } });
    token = account.token;
    accountId = account.id;
  });

  afterAll(closeTestDb);

  const list = () => request(app).get('/api/riders').set(...authHeader(token));
  const archive = (riderId) => request(app).delete(`/api/riders/${riderId}`).set(...authHeader(token));

  test('creates and lists rider profiles without assigning an organization role', async () => {
    const initial = await list();
    expect(initial.status).toBe(200);
    expect(initial.body.data).toHaveLength(1);
    expect(initial.body.data[0]).not.toHaveProperty('serviceType');
    expect(initial.body.data[0]).not.toHaveProperty('role');

    const created = await request(app)
      .post('/api/riders')
      .set(...authHeader(token))
      .send({ fullName: 'Alex Perera', contactPhone: '0772222222' });
    expect(created.status).toBe(201);
    expect(created.body.data.fullName).toBe('Alex Perera');
    expect(created.body.data.contactPhone).toBe('0772222222');

    const stored = await RiderProfile.findById(created.body.data._id);
    expect(stored).not.toBeNull();
  });

  test('keeps the previous students endpoint as a compatibility alias', async () => {
    const response = await request(app).get('/api/students').set(...authHeader(token));
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
  });

  // Riders on one account are siblings in one household: each has its own code,
  // pass and enrollments, and the account holder's own row is just the rider
  // that shares the account's id. So any of them can be archived, but never the
  // last one.
  describe('DELETE /api/riders/:riderId', () => {
    test('archives a rider the account holder added', async () => {
      const added = await request(app)
        .post('/api/riders')
        .set(...authHeader(token))
        .send({ fullName: 'Sanduni Perera', contactPhone: '0773333333' });
      expect(added.status).toBe(201);

      const res = await archive(added.body.data._id);
      expect(res.status).toBe(200);

      const after = await list();
      expect(after.body.data.map((rider) => rider._id)).not.toContain(added.body.data._id);
      const stored = await RiderProfile.findById(added.body.data._id);
      expect(stored.isActive).toBe(false);
    });

    test("archives the account holder's own rider while another rider remains", async () => {
      const before = await list();
      const self = before.body.data.find((rider) => rider.isSelf);
      expect(self).toBeDefined();
      expect(before.body.data).toHaveLength(2);

      const res = await archive(self._id);
      expect(res.status).toBe(200);

      const after = await list();
      expect(after.status).toBe(200);
      expect(after.body.data).toHaveLength(1);
      expect(after.body.data[0].fullName).toBe('Alex Perera');
      expect(after.body.data[0].isSelf).toBe(false);
      // The list did not quietly recreate the archived row for the account.
      expect(await RiderProfile.countDocuments({ accountId, isActive: { $ne: false } })).toBe(1);
    });

    test('refuses to archive the last rider on the account', async () => {
      const before = await list();
      expect(before.body.data).toHaveLength(1);
      const last = before.body.data[0];

      const res = await archive(last._id);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LAST_RIDER');

      const after = await list();
      expect(after.body.data).toHaveLength(1);
      expect(after.body.data[0]._id).toBe(last._id);
      const stored = await RiderProfile.findById(last._id);
      expect(stored.isActive).toBe(true);
    });
  });
});
