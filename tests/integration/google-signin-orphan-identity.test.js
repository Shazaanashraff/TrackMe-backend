const request = require('supertest');
const { OAuth2Client } = require('google-auth-library');
const app = require('../../src/server');
const Identity = require('../../src/models/Identity');
const { createIdentityWithProfile } = require('../../src/utils/identityRegistry');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// "This login has no account for this app" must not be a dead end for someone signing up
// with Google. An Identity can exist with no profile at all (a sign-up that created the
// login and then failed before the rider profile, or a profile removed later). Nothing is
// being shared in that case, so Google sign-in has to attach the rider profile rather than
// refuse. An identity that really belongs to another role stays refused while
// ALLOW_SHARED_IDENTITY is off.

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
    getPayload: () => ({ email, email_verified: true, sub: `google-sub-${email}`, name: 'Tester One' })
  });
};

describe('POST /api/auth/google — identity without a rider profile', () => {
  it('attaches a rider profile to an orphaned identity instead of refusing', async () => {
    const email = `orphan-${Date.now()}@test.com`;
    await Identity.create({ email, password: 'Password123!', isEmailVerified: false });
    mockGoogleTicket(email);

    const res = await request(app).post('/api/auth/google').send({ idToken: 'fake-id-token' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.role).toBe('user');
  });

  it('still refuses an email that belongs to a driver while shared identities are off', async () => {
    const email = `driver-${Date.now()}@test.com`;
    await createIdentityWithProfile({
      email,
      password: 'Password123!',
      isEmailVerified: true,
      role: 'driver',
      fields: { name: 'Some Driver' }
    });
    mockGoogleTicket(email);

    const res = await request(app).post('/api/auth/google').send({ idToken: 'fake-id-token' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_PROFILE_FOR_APP');
  });
});
