const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Covers POST /api/auth/forgot-password/request-otp + verify-otp, including the
// brute-force lockout on verify-otp (issue #4): no RESEND_API_KEY is configured
// in the test env, so requestPasswordResetOtp always falls back to returning
// `developmentOtp` in the response body instead of actually emailing it.
//
// Each test uses its own account/email: request-otp is also rate-limited per
// email (issue #2/#3, 3 requests/10 min by default), and these scenarios each
// issue 2+ requests — sharing one email across tests would trip that limiter
// and mask what's actually being tested here.

async function createUser() {
  const email = `pwreset-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
  await User.create({
    name: 'Reset Tester', email, password: 'P@ssw0rd!',
    role: 'user', isEmailVerified: true, isActive: true
  });
  return email;
}

async function requestOtp(email) {
  const res = await request(app)
    .post('/api/auth/forgot-password/request-otp')
    .send({ email });
  return res.body.developmentOtp;
}

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe('Password reset OTP', () => {
  it('a correct OTP on a fresh request verifies successfully', async () => {
    const email = await createUser();
    const otp = await requestOtp(email);

    const res = await request(app)
      .post('/api/auth/forgot-password/verify-otp')
      .send({ email, otp });

    expect(res.status).toBe(200);
    expect(res.body.resetToken).toBeTruthy();
  });

  it('locks out the code after 5 wrong attempts, rejecting even the correct code afterwards', async () => {
    const email = await createUser();
    const otp = await requestOtp(email);

    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post('/api/auth/forgot-password/verify-otp')
        .send({ email, otp: '000000' });
      expect(res.status).toBe(400);
    }

    // 5th wrong attempt trips the lockout.
    const lockoutRes = await request(app)
      .post('/api/auth/forgot-password/verify-otp')
      .send({ email, otp: '000000' });
    expect(lockoutRes.status).toBe(400);

    // Now even the real code is rejected — the OTP was invalidated, not just expired.
    const afterLockoutRes = await request(app)
      .post('/api/auth/forgot-password/verify-otp')
      .send({ email, otp });
    expect(afterLockoutRes.status).toBe(400);
    expect(afterLockoutRes.body.resetToken).toBeUndefined();
  });

  it('a fresh reset request after lockout issues a new usable code', async () => {
    const email = await createUser();

    // Trip the lockout on the first code.
    await requestOtp(email);
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/auth/forgot-password/verify-otp')
        .send({ email, otp: '000000' });
    }

    // Requesting again should hand back a fresh, working code.
    const freshOtp = await requestOtp(email);
    const res = await request(app)
      .post('/api/auth/forgot-password/verify-otp')
      .send({ email, otp: freshOtp });

    expect(res.status).toBe(200);
    expect(res.body.resetToken).toBeTruthy();
  });

  it('reports success=false with a 502 when the reset email fails to send in production (issue #5)', async () => {
    const email = await createUser();
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      // No RESEND_API_KEY is configured in the test env, so the send still
      // fails — but in production there's no developmentOtp fallback, so the
      // client needs an honest failure signal instead of a misleading 200.
      const res = await request(app)
        .post('/api/auth/forgot-password/request-otp')
        .send({ email });

      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.developmentOtp).toBeUndefined();
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('still reports success=true for an unregistered email even when NODE_ENV is production (no enumeration signal)', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      const res = await request(app)
        .post('/api/auth/forgot-password/request-otp')
        .send({ email: 'no-such-account-prod@test.com' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('expires the reset OTP sooner than an email-verification OTP (issue #13)', async () => {
    const email = await createUser();
    await requestOtp(email);

    const withReset = await User.findOne({ email }).select('+passwordReset.expiresAt');
    const resetExpiryMs = withReset.passwordReset.expiresAt.getTime() - Date.now();
    // 5-minute window, allowing slack for test execution time.
    expect(resetExpiryMs).toBeGreaterThan(4.5 * 60 * 1000);
    expect(resetExpiryMs).toBeLessThanOrEqual(5 * 60 * 1000);

    const registerRes = await request(app).post('/api/auth/register').send({
      name: 'Verify Expiry Tester',
      email: `verify-expiry-${Date.now()}@test.com`,
      password: 'P@ssw0rd!'
    });
    expect(registerRes.status).toBe(201);

    const withVerification = await User.findOne({ email: registerRes.body.email }).select('+emailVerification.expiresAt');
    const verificationExpiryMs = withVerification.emailVerification.expiresAt.getTime() - Date.now();
    // 10-minute window, allowing slack for test execution time.
    expect(verificationExpiryMs).toBeGreaterThan(9.5 * 60 * 1000);
    expect(verificationExpiryMs).toBeLessThanOrEqual(10 * 60 * 1000);

    expect(resetExpiryMs).toBeLessThan(verificationExpiryMs);
  });
});
