const request = require('supertest');

// Never hit the real Resend API from tests — .env has a live RESEND_API_KEY.
// Simulate "email delivery unavailable" so authController falls back to
// returning `developmentOtp` in the response, which these tests read directly.
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: jest.fn().mockResolvedValue({ data: null, error: { message: 'mocked in tests' } }),
    },
  })),
}));

const app = require('../../src/server');
const User = require('../../src/models/User');
const { connectTestDb, closeTestDb } = require('./db');

// Matches the real API: POST /api/auth/login returns
// { success, message, accessToken, refreshToken, user } on success.

const VALID = {
  name: 'Login Tester',
  email: `login-${Date.now()}@test.com`,
  password: 'P@ssw0rd!',
};

beforeAll(async () => {
  await connectTestDb();
  await User.deleteMany({ email: VALID.email });
  // Password is hashed by the User pre-save hook; email pre-verified so login isn't gated.
  await User.create({
    name: VALID.name,
    email: VALID.email,
    password: VALID.password,
    role: 'user',
    isEmailVerified: true,
    isActive: true,
  });
});

afterAll(async () => {
  await closeTestDb();
});

describe('Auth Integration - POST /api/auth/login', () => {
  test('valid credentials return 200 with an access token', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: VALID.email, password: VALID.password })
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
    expect(res.body.user.email).toBe(VALID.email.toLowerCase());
  });

  test('invalid credentials return 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nope@example.com', password: 'wrong-password' })
      .set('Accept', 'application/json');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/invalid email or password/i);
  });

  test('wrong password for an existing user returns 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: VALID.email, password: 'definitely-wrong' })
      .set('Accept', 'application/json');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  test('missing password returns 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: VALID.email })
      .set('Accept', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    // Request validation middleware rejects before the controller body check.
    expect(res.body.message).toMatch(/validation failed|provide email and password/i);
  });

  test('unverified account returns 403 with requiresVerification + email', async () => {
    const email = `unverified-${Date.now()}@test.com`;
    await User.create({
      name: 'Unverified Tester',
      email,
      password: VALID.password,
      role: 'user',
      isEmailVerified: false,
      isActive: true,
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email, password: VALID.password })
      .set('Accept', 'application/json');

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.requiresVerification).toBe(true);
    expect(res.body.email).toBe(email);
  });
});

describe('Auth Integration - POST /api/auth/register + POST /api/auth/verify-email', () => {
  const email = `register-${Date.now()}@test.com`;
  let developmentOtp;

  test('register creates an unverified user and requires verification', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'New User', email, password: 'P@ssw0rd!' })
      .set('Accept', 'application/json');

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.requiresVerification).toBe(true);
    expect(res.body.email).toBe(email);
    expect(res.body.user.isEmailVerified).toBe(false);
    // No RESEND_API_KEY in the test env, so the OTP is echoed back for dev/testing.
    expect(typeof res.body.developmentOtp).toBe('string');
    developmentOtp = res.body.developmentOtp;
  });

  test('verify-email rejects an incorrect OTP', async () => {
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ email, otp: '000000' })
      .set('Accept', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/invalid otp/i);
  });

  test('verify-email with the correct OTP verifies the account and returns tokens', async () => {
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ email, otp: developmentOtp })
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.accessToken).toBe('string');
    expect(res.body.user.isEmailVerified).toBe(true);
  });
});

describe('Auth Integration - PUT /api/auth/profile (phone number)', () => {
  const PROFILE_USER = {
    name: 'Profile Tester',
    email: `profile-${Date.now()}@test.com`,
    password: 'P@ssw0rd!',
  };
  let token;

  beforeAll(async () => {
    await User.create({
      ...PROFILE_USER,
      role: 'user',
      isEmailVerified: true,
      isActive: true,
    });
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: PROFILE_USER.email, password: PROFILE_USER.password });
    token = login.body.accessToken;
  });

  test('accepts and persists a phoneNumber, returned on the user object', async () => {
    const res = await request(app)
      .put('/api/auth/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: PROFILE_USER.name, phoneNumber: '077 123 4567' })
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.phoneNumber).toBe('077 123 4567');

    const stored = await User.findOne({ email: PROFILE_USER.email });
    expect(stored.phoneNumber).toBe('077 123 4567');
  });

  test('rejects an obviously malformed phoneNumber', async () => {
    const res = await request(app)
      .put('/api/auth/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: PROFILE_USER.name, phoneNumber: 'not-a-phone-number!!' })
      .set('Accept', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('allows clearing the phone number with an empty string', async () => {
    const res = await request(app)
      .put('/api/auth/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: PROFILE_USER.name, phoneNumber: '' })
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.user.phoneNumber).toBe('');
  });

  test('rejects when unauthenticated', async () => {
    const res = await request(app)
      .put('/api/auth/profile')
      .send({ name: PROFILE_USER.name, phoneNumber: '0771234567' })
      .set('Accept', 'application/json');

    expect(res.status).toBe(401);
  });
});

describe('Auth Integration - PUT /api/auth/avatar (profile picture)', () => {
  const AVATAR_USER = {
    name: 'Avatar Tester',
    email: `avatar-${Date.now()}@test.com`,
    password: 'P@ssw0rd!',
  };
  // 1x1 transparent PNG.
  const VALID_AVATAR =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  let token;

  beforeAll(async () => {
    await User.create({
      ...AVATAR_USER,
      role: 'user',
      isEmailVerified: true,
      isActive: true,
    });
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: AVATAR_USER.email, password: AVATAR_USER.password });
    token = login.body.accessToken;
  });

  test('login returns an (empty) avatarUrl field by default', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: AVATAR_USER.email, password: AVATAR_USER.password });

    expect(res.body.user).toHaveProperty('avatarUrl', '');
  });

  test('accepts a valid image data URL and persists it', async () => {
    const res = await request(app)
      .put('/api/auth/avatar')
      .set('Authorization', `Bearer ${token}`)
      .send({ avatar: VALID_AVATAR })
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.avatarUrl).toBe(VALID_AVATAR);

    const stored = await User.findOne({ email: AVATAR_USER.email });
    expect(stored.avatarUrl).toBe(VALID_AVATAR);
  });

  test('rejects a non-image / malformed data URL with 400', async () => {
    const res = await request(app)
      .put('/api/auth/avatar')
      .set('Authorization', `Bearer ${token}`)
      .send({ avatar: 'data:text/plain;base64,aGVsbG8=' })
      .set('Accept', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('rejects an image larger than the 2 MB cap with 413', async () => {
    // ~2.1 MB decoded (2_800_000 base64 chars * 3/4), over the 2 MB limit.
    const oversized = `data:image/png;base64,${'A'.repeat(2_800_000)}`;
    const res = await request(app)
      .put('/api/auth/avatar')
      .set('Authorization', `Bearer ${token}`)
      .send({ avatar: oversized })
      .set('Accept', 'application/json');

    expect(res.status).toBe(413);
    expect(res.body.success).toBe(false);
  });

  test('clears the avatar when sent an empty string', async () => {
    const res = await request(app)
      .put('/api/auth/avatar')
      .set('Authorization', `Bearer ${token}`)
      .send({ avatar: '' })
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body.user.avatarUrl).toBe('');

    const stored = await User.findOne({ email: AVATAR_USER.email });
    expect(stored.avatarUrl).toBe('');
  });

  test('rejects when unauthenticated', async () => {
    const res = await request(app)
      .put('/api/auth/avatar')
      .send({ avatar: VALID_AVATAR })
      .set('Accept', 'application/json');

    expect(res.status).toBe(401);
  });
});
