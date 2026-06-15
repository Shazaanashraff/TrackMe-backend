const request = require('supertest');
const app = require('../../src/server');
const fixtures = require('../mock.json');

describe('Auth Integration - /api/auth/login', () => {
  test('returns 200 and token on valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send(fixtures.login.valid)
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(typeof res.body.token).toBe('string');
    expect(res.body.code).toMatch(/AUTH_/);
  });

  test('invalid credentials return 401 with AUTH_INVALID_CREDENTIALS', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nope@example.com', password: 'wrong' })
      .set('Accept', 'application/json');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  test('malformed JSON returns 400 and MALFORMED_JSON', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('not-a-json');

    expect([400, 415]).toContain(res.status);
    expect(res.body.code).toBe('MALFORMED_JSON');
  });

  test('missing fields returns 400 and AUTH_MISSING_FIELDS', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: fixtures.users[1].email })
      .set('Accept', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUTH_MISSING_FIELDS');
  });

  // Note: rate limit and injected-server-error tests require environment support/stubs.
});
