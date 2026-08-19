const request = require('supertest');
const { OAuth2Client } = require('google-auth-library');
const app = require('../../src/server');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// A first-time Google sign-in (no existing Identity for that email) crashed with a
// 500 — createIdentityWithProfile passes no `password`, but the pre('save') hash
// hook in models/shared/passwordAuth.js ran bcrypt.hash(undefined, 12) anyway,
// because isModified('password') is true on a new document even when the field
// was explicitly set to undefined (issue #111). verifyIdToken is mocked since it
// calls out to Google.

let verifyIdTokenSpy;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  process.env.NODE_ENV = 'test';
  process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-google-client-id';
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
      name: 'Google Newcomer'
    })
  });
};

describe('POST /api/auth/google — first-time sign-in', () => {
  it('creates the account and issues tokens for an unseen email', async () => {
    const email = `google-newcomer-${Date.now()}@test.com`;
    mockGoogleTicket(email);

    const res = await request(app).post('/api/auth/google').send({ idToken: 'fake-id-token' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.email).toBe(email);
  });

  it('signing in again with the same Google email reuses the account (no password set)', async () => {
    const email = `google-repeat-${Date.now()}@test.com`;
    mockGoogleTicket(email);

    const first = await request(app).post('/api/auth/google').send({ idToken: 'fake-id-token' });
    expect(first.status).toBe(200);

    const second = await request(app).post('/api/auth/google').send({ idToken: 'fake-id-token' });
    expect(second.status).toBe(200);
    expect(second.body.user.email).toBe(email);
  });
});
