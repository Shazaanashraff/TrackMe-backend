const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Covers POST /api/auth/forgot-password/request-otp + verify-otp, including the
// brute-force lockout on verify-otp (issue #4): no RESEND_API_KEY is configured
// in the test env, so requestPasswordResetOtp always falls back to returning
// `developmentOtp` in the response body instead of actually emailing it.

const USER = { email: `pwreset-${Date.now()}@test.com`, password: 'P@ssw0rd!' };

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  await User.create({
    name: 'Reset Tester', email: USER.email, password: USER.password,
    role: 'user', isEmailVerified: true, isActive: true
  });
});

afterAll(async () => {
  await closeTestDb();
});

async function requestOtp() {
  const res = await request(app)
    .post('/api/auth/forgot-password/request-otp')
    .send({ email: USER.email });
  return res.body.developmentOtp;
}

describe('Password reset OTP', () => {
  it('a correct OTP on a fresh request verifies successfully', async () => {
    const otp = await requestOtp();

    const res = await request(app)
      .post('/api/auth/forgot-password/verify-otp')
      .send({ email: USER.email, otp });

    expect(res.status).toBe(200);
    expect(res.body.resetToken).toBeTruthy();
  });

  it('locks out the code after 5 wrong attempts, rejecting even the correct code afterwards', async () => {
    const otp = await requestOtp();

    for (let i = 0; i < 4; i++) {
      const res = await request(app)
        .post('/api/auth/forgot-password/verify-otp')
        .send({ email: USER.email, otp: '000000' });
      expect(res.status).toBe(400);
    }

    // 5th wrong attempt trips the lockout.
    const lockoutRes = await request(app)
      .post('/api/auth/forgot-password/verify-otp')
      .send({ email: USER.email, otp: '000000' });
    expect(lockoutRes.status).toBe(400);

    // Now even the real code is rejected — the OTP was invalidated, not just expired.
    const afterLockoutRes = await request(app)
      .post('/api/auth/forgot-password/verify-otp')
      .send({ email: USER.email, otp });
    expect(afterLockoutRes.status).toBe(400);
    expect(afterLockoutRes.body.resetToken).toBeUndefined();
  });

  it('a fresh reset request after lockout issues a new usable code', async () => {
    // Trip the lockout on the first code.
    await requestOtp();
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/auth/forgot-password/verify-otp')
        .send({ email: USER.email, otp: '000000' });
    }

    // Requesting again should hand back a fresh, working code.
    const freshOtp = await requestOtp();
    const res = await request(app)
      .post('/api/auth/forgot-password/verify-otp')
      .send({ email: USER.email, otp: freshOtp });

    expect(res.status).toBe(200);
    expect(res.body.resetToken).toBeTruthy();
  });
});
