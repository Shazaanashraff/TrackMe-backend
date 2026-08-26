const request = require('supertest');
const { OAuth2Client } = require('google-auth-library');
const app = require('../../src/server');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createSuperAdmin } = require('./factories');

// googleSignIn's SUPER_ADMIN_ISOLATED guard (authController.js ~519-526) had zero
// test coverage (issue #71) — it exists specifically so a Google account can never
// reach a super-admin login. verifyIdToken is mocked since it calls out to Google.

let superAdminEmail;
let verifyIdTokenSpy;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';
  process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-google-client-id';

  ({ email: superAdminEmail } = await createSuperAdmin({ name: 'Isolated Super Admin' }));
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

afterEach(() => {
  verifyIdTokenSpy?.mockRestore();
});

const mockGoogleTicket = (email) => {
  verifyIdTokenSpy = jest.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
    getPayload: () => ({
      email,
      email_verified: true,
      sub: `google-sub-${email}`,
      name: 'Google User'
    })
  });
};

describe('POST /api/auth/google — super-admin isolation', () => {
  it('rejects a super-admin email with SUPER_ADMIN_ISOLATED', async () => {
    mockGoogleTicket(superAdminEmail);

    const res = await request(app).post('/api/auth/google').send({ idToken: 'fake-id-token' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('SUPER_ADMIN_ISOLATED');
  });

  it('does not issue tokens for the rejected super-admin', async () => {
    mockGoogleTicket(superAdminEmail);

    const res = await request(app).post('/api/auth/google').send({ idToken: 'fake-id-token' });

    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
  });
});
