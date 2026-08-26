const request = require('supertest');
const app = require('../../src/server');
const Identity = require('../../src/models/Identity');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const {
  createRider, createManager, createSuperAdmin, uniqueEmail, login, DEFAULT_PASSWORD
} = require('./factories');

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
  const email = uniqueEmail('pwreset');
  await createRider({ name: 'Reset Tester', email, signIn: false });
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

  it('does not echo the OTP outside production when ENABLE_DEV_OTP_ECHO is unset — no leak on a misconfigured NODE_ENV (issue #66)', async () => {
    const email = await createUser();
    const originalFlag = process.env.ENABLE_DEV_OTP_ECHO;
    delete process.env.ENABLE_DEV_OTP_ECHO;

    try {
      // NODE_ENV is 'test' here (not production), so the old gate would have
      // echoed the OTP. The explicit opt-in flag is what must now block it —
      // absence of a production flag is no longer enough on its own.
      const res = await request(app)
        .post('/api/auth/forgot-password/request-otp')
        .send({ email });

      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
      expect(res.body.developmentOtp).toBeUndefined();
    } finally {
      process.env.ENABLE_DEV_OTP_ECHO = originalFlag;
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

    // passwordReset lives on Identity, not the profile — dormant there
    // (shared/accountFields.js).
    const withReset = await Identity.findOne({ email }).select('+passwordReset.expiresAt');
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

    // Same dormant-on-profile / real-on-Identity split as passwordReset above.
    const withVerification = await Identity.findOne({ email: registerRes.body.email })
      .select('+emailVerification.expiresAt');
    const verificationExpiryMs = withVerification.emailVerification.expiresAt.getTime() - Date.now();
    // 10-minute window, allowing slack for test execution time.
    expect(verificationExpiryMs).toBeGreaterThan(9.5 * 60 * 1000);
    expect(verificationExpiryMs).toBeLessThanOrEqual(10 * 60 * 1000);

    expect(resetExpiryMs).toBeLessThan(verificationExpiryMs);
  });
});

// Issue #72: the OTP reset flow + revokeAllSessions had no coverage proving they
// work for a Manager or SuperAdmin identity specifically — everything above only
// exercises a rider. The reset flow is identity-wide (not role-specific), but the
// account lookup/login/audience plumbing differs enough per role that a rider-only
// test doesn't actually prove it works for the other two.
describe('Password reset OTP — Manager/SuperAdmin identities (issue #72)', () => {
  async function resetPassword(email, newPassword = 'N3wP@ssw0rd!') {
    const otp = await requestOtp(email);
    const verifyRes = await request(app)
      .post('/api/auth/forgot-password/verify-otp')
      .send({ email, otp });
    expect(verifyRes.status).toBe(200);

    return request(app)
      .post('/api/auth/forgot-password/reset')
      .send({ email, resetToken: verifyRes.body.resetToken, password: newPassword });
  }

  it('completes the OTP reset flow end-to-end for a Manager', async () => {
    const email = uniqueEmail('pwreset-manager');
    await createManager({ name: 'Reset Manager', email, signIn: false });

    const resetRes = await resetPassword(email);
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.success).toBe(true);

    // New password works…
    const loginRes = await login(email, 'N3wP@ssw0rd!', 'manager');
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.accessToken).toBeTruthy();

    // …and the old one no longer does.
    const oldLoginRes = await login(email, DEFAULT_PASSWORD, 'manager');
    expect(oldLoginRes.status).toBe(401);
  });

  it('completes the OTP reset flow end-to-end for a SuperAdmin', async () => {
    const email = uniqueEmail('pwreset-superadmin');
    await createSuperAdmin({ name: 'Reset SuperAdmin', email, signIn: false });

    const resetRes = await resetPassword(email);
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.success).toBe(true);

    const loginRes = await login(email, 'N3wP@ssw0rd!', 'super-admin');
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.accessToken).toBeTruthy();

    const oldLoginRes = await login(email, DEFAULT_PASSWORD, 'super-admin');
    expect(oldLoginRes.status).toBe(401);
  });

  it("rejects a Manager's pre-reset refresh token after the reset completes (revokeAllSessions)", async () => {
    const email = uniqueEmail('pwreset-manager-revoke');
    await createManager({ name: 'Revoke Manager', email, signIn: false });

    const preResetLogin = await login(email, DEFAULT_PASSWORD, 'manager');
    expect(preResetLogin.status).toBe(200);
    const oldRefreshToken = preResetLogin.body.refreshToken;
    expect(oldRefreshToken).toBeTruthy();

    const resetRes = await resetPassword(email);
    expect(resetRes.status).toBe(200);

    const refreshRes = await request(app)
      .post('/api/auth/refresh-token')
      .send({ refreshToken: oldRefreshToken });
    expect(refreshRes.status).toBe(401);
  });

  it("rejects a SuperAdmin's pre-reset refresh token after the reset completes (revokeAllSessions)", async () => {
    const email = uniqueEmail('pwreset-superadmin-revoke');
    await createSuperAdmin({ name: 'Revoke SuperAdmin', email, signIn: false });

    const preResetLogin = await login(email, DEFAULT_PASSWORD, 'super-admin');
    expect(preResetLogin.status).toBe(200);
    const oldRefreshToken = preResetLogin.body.refreshToken;
    expect(oldRefreshToken).toBeTruthy();

    const resetRes = await resetPassword(email);
    expect(resetRes.status).toBe(200);

    const refreshRes = await request(app)
      .post('/api/auth/refresh-token')
      .send({ refreshToken: oldRefreshToken });
    expect(refreshRes.status).toBe(401);
  });
});
