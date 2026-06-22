const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const { connectTestDb, closeTestDb } = require('./db');

// Matches the real API: POST /api/auth/login returns
// { success, message, accessToken, refreshToken, user } on success.

const VALID = {
  name: 'Login Tester',
  email: `login-${Date.now()}@test.com`,
  password: 'P@ssw0rd!',
};

beforeAll(async () => {
  await connectTestDb();
  await User.deleteMany({ email: VALID.email });
  // Password is hashed by the User pre-save hook; email pre-verified so login isn't gated.
  await User.create({
    name: VALID.name,
    email: VALID.email,
    password: VALID.password,
    role: 'user',
    isEmailVerified: true,
    isActive: true,
  });
});

afterAll(async () => {
  await closeTestDb();
});

describe('Auth Integration - POST /api/auth/login', () => {
  test('valid credentials return 200 with an access token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: VALID.email, password: VALID.password })
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    expect(res.body.user.email).toBe(VALID.email.toLowerCase());
  });

  test('invalid credentials return 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nope@example.com', password: 'wrong-password' })
      .set('Accept', 'application/json');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/invalid email or password/i);
  });

  test('wrong password for an existing user returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: VALID.email, password: 'definitely-wrong' })
      .set('Accept', 'application/json');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('missing password returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: VALID.email })
      .set('Accept', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    // Request validation middleware rejects before the controller body check.
    expect(res.body.message).toMatch(/validation failed|provide email and password/i);
  });
});
