const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const RiderProfile = require('../../src/models/RiderProfile');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

describe('neutral rider profile API', () => {
  let token;

  beforeAll(async () => {
    await connectTestDb();
    await clearTestDb();
    const account = await User.create({
      name: 'Account Holder',
      email: `rider-profile-${Date.now()}@test.com`,
      password: 'P@ssw0rd!',
      phoneNumber: '0771111111',
      role: 'user',
      isEmailVerified: true,
      isActive: true
    });
    const login = await request(app).post('/api/auth/login').send({ email: account.email, password: 'P@ssw0rd!' });
    token = login.body.accessToken;
  });

  afterAll(closeTestDb);

  test('creates and lists rider profiles without assigning an organization role', async () => {
    const initial = await request(app).get('/api/riders').set('Authorization', `Bearer ${token}`);
    expect(initial.status).toBe(200);
    expect(initial.body.data).toHaveLength(1);
    expect(initial.body.data[0]).not.toHaveProperty('serviceType');
    expect(initial.body.data[0]).not.toHaveProperty('role');

    const created = await request(app)
      .post('/api/riders')
      .set('Authorization', `Bearer ${token}`)
      .send({ fullName: 'Alex Perera', contactPhone: '0772222222' });
    expect(created.status).toBe(201);
    expect(created.body.data.fullName).toBe('Alex Perera');
    expect(created.body.data.contactPhone).toBe('0772222222');

    const stored = await RiderProfile.findById(created.body.data._id);
    expect(stored).not.toBeNull();
  });

  test('keeps the previous students endpoint as a compatibility alias', async () => {
    const response = await request(app).get('/api/students').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
  });
});
