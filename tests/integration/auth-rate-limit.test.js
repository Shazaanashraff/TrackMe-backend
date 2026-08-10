// Must be set before src/server (and therefore src/routes/authRoutes) is first
// required, since the routes module reads these once at load time to build its
// rate limiters. A short window keeps the "resets after the window" case fast.
process.env.AUTH_EMAIL_RATE_LIMIT_WINDOW_MS = '300';
process.env.AUTH_EMAIL_RATE_LIMIT_MAX = '3';

const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Covers rate limiting on POST /api/auth/resend-verification-otp (issue #3) and
// POST /api/auth/forgot-password/request-otp (issue #2): both throttle per
// email address, independently of each other and of other emails.

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  await User.create({
    name: 'Rate Limit Tester', email: 'ratelimit-target@test.com', password: 'P@ssw0rd!',
    role: 'user', isEmailVerified: false, isActive: true
  });
});

afterAll(async () => {
  await closeTestDb();
});

describe('Auth email rate limiting', () => {
  it('throttles resend-verification-otp after 3 requests for the same email, then resets after the window', async () => {
    const email = 'resend-throttle@test.com';

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/auth/resend-verification-otp').send({ email });
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).post('/api/auth/resend-verification-otp').send({ email });
    expect(blocked.status).toBe(429);

    await wait(350);

    const afterWindow = await request(app).post('/api/auth/resend-verification-otp').send({ email });
    expect(afterWindow.status).toBe(200);
  });

  it('throttles forgot-password/request-otp after 3 requests for the same email, without revealing whether the email exists', async () => {
    const unknownEmail = 'no-such-account@test.com';

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/auth/forgot-password/request-otp').send({ email: unknownEmail });
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).post('/api/auth/forgot-password/request-otp').send({ email: unknownEmail });
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).not.toMatch(/exist|found|register/i);
  });

  it('rate limits are independent per email address', async () => {
    const emailA = 'independent-a@test.com';
    const emailB = 'independent-b@test.com';

    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/auth/forgot-password/request-otp').send({ email: emailA });
    }
    const aBlocked = await request(app).post('/api/auth/forgot-password/request-otp').send({ email: emailA });
    expect(aBlocked.status).toBe(429);

    const bAllowed = await request(app).post('/api/auth/forgot-password/request-otp').send({ email: emailB });
    expect(bAllowed.status).toBe(200);
  });
});
