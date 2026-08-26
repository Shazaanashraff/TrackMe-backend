// Must be set before src/server (and therefore src/middleware/rateLimiters) is
// first required, since it reads these once at module load time to build its
// limiters. Small windows/max keep the "resets after the window" case fast.
process.env.AUTH_IP_RATE_LIMIT_WINDOW_MS = '300';
process.env.AUTH_IP_RATE_LIMIT_MAX = '3';
process.env.API_RATE_LIMIT_WINDOW_MS = '300';
process.env.API_RATE_LIMIT_MAX = '1000';

const request = require('supertest');
const app = require('../../src/server');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Covers the IP-based limiter in src/middleware/rateLimiters.js — distinct from
// the per-identity limiters in emailRateLimiter.js (auth-rate-limit.test.js),
// which don't stop one client from hammering many different accounts.

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('Auth IP-based rate limiting', () => {
  it('throttles requests to /api/auth/* after the configured max, then resets after the window', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post('/api/auth/forgot-password/request-otp')
        .send({ email: `ip-limit-${i}@test.com` });
      expect(res.status).not.toBe(429);
    }

    const blocked = await request(app)
      .post('/api/auth/forgot-password/request-otp')
      .send({ email: 'ip-limit-blocked@test.com' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.success).toBe(false);

    await wait(350);

    const afterWindow = await request(app)
      .post('/api/auth/forgot-password/request-otp')
      .send({ email: 'ip-limit-after-window@test.com' });
    expect(afterWindow.status).not.toBe(429);
  });
});
