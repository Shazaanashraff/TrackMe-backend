const request = require('supertest');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const app = require('../../src/server');
const User = require('../../src/models/User');
const Identity = require('../../src/models/Identity');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// A managed rider profile (a child, a second commuter) has no email or login
// of its own — its identity's email is what has to show up everywhere the
// app displays "your account". These lock the fixes that make that true:
// getMe, updateProfile, updateAvatar and refresh-token all re-hydrate the
// Identity rather than falling back to the profile's own (always empty)
// email/isEmailVerified. There is no /api/profiles/:id/switch endpoint yet
// (Phase 3), so tokens for the managed profile are hand-signed here, matching
// the pattern already used for forged-token cases elsewhere in this suite.

const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');

let identity;
let managedProfile;
let managedAccessToken;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  identity = await Identity.create({
    email: `parent-managed-${Date.now()}@t.com`,
    password: 'P@ssw0rd!',
    isEmailVerified: true
  });

  await User.create({
    name: 'Parent', identityId: identity._id, email: identity.email, profileKind: 'PRIMARY'
  });

  managedProfile = await User.create({
    name: 'Managed Child', identityId: identity._id, profileKind: 'MANAGED', relation: 'Daughter'
  });

  managedAccessToken = jwt.sign(
    { id: managedProfile._id, role: 'user', tokenType: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

describe('GET /api/auth/me for a managed profile', () => {
  it('returns the account holder email, not a blank one', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${managedAccessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Managed Child');
    expect(res.body.user.email).toBe(identity.email);
    expect(res.body.user.profileKind).toBe('MANAGED');
  });
});

describe('PUT /api/auth/profile for a managed profile', () => {
  it('renames the profile but ignores a submitted phoneNumber', async () => {
    const res = await request(app)
      .put('/api/auth/profile')
      .set('Authorization', `Bearer ${managedAccessToken}`)
      .send({ name: 'Renamed Child', phoneNumber: '0771234567' });

    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Renamed Child');
    expect(res.body.user.email).toBe(identity.email);
    // The account holder's phone must never be overwritten by a request sent
    // while a managed profile is active.
    expect(res.body.user.phoneNumber).not.toBe('0771234567');

    const stored = await User.findById(managedProfile._id);
    expect(stored.phoneNumber).not.toBe('0771234567');
  });
});

describe('PUT /api/auth/avatar for a managed profile', () => {
  const VALID_AVATAR =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('updates the avatar and still reports the account holder email', async () => {
    const res = await request(app)
      .put('/api/auth/avatar')
      .set('Authorization', `Bearer ${managedAccessToken}`)
      .send({ avatar: VALID_AVATAR });

    expect(res.status).toBe(200);
    expect(res.body.user.avatarUrl).toBe(VALID_AVATAR);
    expect(res.body.user.email).toBe(identity.email);
  });
});

describe('POST /api/auth/refresh-token for a managed profile', () => {
  it('returns a fresh token pair with the account holder email, not blank', async () => {
    const refreshToken = jwt.sign(
      { id: managedProfile._id, role: 'user', tokenType: 'refresh' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    await User.findByIdAndUpdate(managedProfile._id, {
      refreshToken: {
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      }
    });

    const res = await request(app).post('/api/auth/refresh-token').send({ refreshToken });

    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.user.email).toBe(identity.email);
  });
});
