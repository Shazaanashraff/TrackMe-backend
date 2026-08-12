// Must be set before src/server (and therefore src/routes/authRoutes) is first
// required, since the routes module reads these once at load time to build its
// rate limiters. A short window keeps the "resets after the window" case fast.
process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS = '300';
process.env.AUTH_LOGIN_RATE_LIMIT_MAX = '3';

const request = require('supertest');
const app = require('../../src/server');
const User = require('../../src/models/User');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// Issue #35: POST /api/auth/login had no rate limiting or lockout of its own,
// so a stolen/guessed identifier could be brute-forced against a real password
// with no throttling at all.
//
// These attempts deliberately target identifiers with no matching account:
// login 401s on an unknown identifier before ever calling bcrypt.compare, so
// the requests stay fast and the short test window stays reliable — a real
// account's wrong-password path goes through bcrypt's deliberately slow
// compare, which alone can eat past a short window and make this flaky.

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const stamp = Date.now();

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  await User.create({
    name: 'Login Rate Limit Real Account',
    email: `login-throttle-real-${stamp}@test.com`,
    password: 'P@ssw0rd!',
    role: 'user',
    isEmailVerified: true,
    isActive: true
  });
});

afterAll(async () => {
  await closeTestDb();
});

describe('Login rate limiting', () => {
  it('throttles login after 3 attempts for the same identifier, then resets after the window', async () => {
    const unknownIdentifier = `login-throttle-unknown-${stamp}@test.com`;

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/auth/login').send({ identifier: unknownIdentifier, password: 'whatever' });
      expect(res.status).toBe(401);
    }

    const blocked = await request(app).post('/api/auth/login').send({ identifier: unknownIdentifier, password: 'whatever' });
    expect(blocked.status).toBe(429);

    await wait(350);

    const afterWindow = await request(app).post('/api/auth/login').send({ identifier: unknownIdentifier, password: 'whatever' });
    expect(afterWindow.status).toBe(401);
  });

  it('rate limits are independent per identifier', async () => {
    const identifierA = `login-independent-a-${stamp}@test.com`;
    const identifierB = `login-independent-b-${stamp}@test.com`;

    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/auth/login').send({ identifier: identifierA, password: 'whatever' });
    }
    const aBlocked = await request(app).post('/api/auth/login').send({ identifier: identifierA, password: 'whatever' });
    expect(aBlocked.status).toBe(429);

    const bAllowed = await request(app).post('/api/auth/login').send({ identifier: identifierB, password: 'whatever' });
    expect(bAllowed.status).toBe(401);
  });

  it('a real account can still log in when its own bucket is not exhausted', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ identifier: `login-throttle-real-${stamp}@test.com`, password: 'P@ssw0rd!' });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });
});
