const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

// On Render, req.ip was a proxy address, so one phone was counted in several
// rotating buckets and every rider behind the same Cloudflare edge shared
// them; two phones on one Wi-Fi also shared one allowance. The general limiter
// now counts a signed-in request against its account, and anything else
// against CF-Connecting-IP (falling back to req.ip). No database.

const SECRET = 'rate-limiters-test-secret';

// The limiters read their limits once at load, so each test builds a fresh
// app with small limits and its own empty store.
function freshApp() {
  process.env.JWT_SECRET = SECRET;
  process.env.API_RATE_LIMIT_MAX = '2';
  process.env.API_RATE_LIMIT_WINDOW_MS = '60000';
  process.env.AUTH_IP_RATE_LIMIT_MAX = '2';
  process.env.AUTH_IP_RATE_LIMIT_WINDOW_MS = '60000';
  let limiters;
  jest.isolateModules(() => {
    limiters = require('../../src/middleware/rateLimiters');
  });
  const app = express();
  app.use('/api/', limiters.apiLimiter);
  app.use('/api/auth', limiters.authLimiter);
  app.get('/api/ping', (req, res) => res.json({ ok: true }));
  app.post('/api/auth/login', (req, res) => res.json({ ok: true }));
  return app;
}

const token = (id, { role = 'user', tokenType = 'access', secret = SECRET } = {}) =>
  jwt.sign({ id, role, tokenType }, secret, { algorithm: 'HS256', expiresIn: '15m' });

function ping(app, { bearer, ip } = {}) {
  const req = request(app).get('/api/ping');
  if (bearer) req.set('Authorization', `Bearer ${bearer}`);
  if (ip) req.set('CF-Connecting-IP', ip);
  return req;
}

async function exhaust(app, options) {
  expect((await ping(app, options)).status).toBe(200);
  expect((await ping(app, options)).status).toBe(200);
  expect((await ping(app, options)).status).toBe(429);
}

afterAll(() => {
  delete process.env.API_RATE_LIMIT_MAX;
  delete process.env.API_RATE_LIMIT_WINDOW_MS;
  delete process.env.AUTH_IP_RATE_LIMIT_MAX;
  delete process.env.AUTH_IP_RATE_LIMIT_WINDOW_MS;
});

describe('apiLimiter', () => {
  it('gives two accounts on one address their own allowance', async () => {
    const app = freshApp();
    await exhaust(app, { bearer: token('rider-a'), ip: '203.0.113.10' });

    expect((await ping(app, { bearer: token('rider-b'), ip: '203.0.113.10' })).status).toBe(200);
  });

  it('counts one account the same from any address', async () => {
    const app = freshApp();
    const bearer = token('driver-1', { role: 'driver' });
    expect((await ping(app, { bearer, ip: '203.0.113.20' })).status).toBe(200);
    expect((await ping(app, { bearer, ip: '198.51.100.20' })).status).toBe(200);

    expect((await ping(app, { bearer, ip: '192.0.2.20' })).status).toBe(429);
  });

  it('keys a request with no token on CF-Connecting-IP, not on the proxy address', async () => {
    const app = freshApp();
    // Every request here reaches the app from the same req.ip, as on Render.
    await exhaust(app, { ip: '203.0.113.30' });

    expect((await ping(app, { ip: '198.51.100.30' })).status).toBe(200);
  });

  it('counts a forged or refresh token against the address, not the account it names', async () => {
    const app = freshApp();
    await exhaust(app, { bearer: token('victim', { secret: 'not-the-secret' }), ip: '203.0.113.40' });
    expect((await ping(app, { bearer: token('victim', { tokenType: 'refresh' }), ip: '203.0.113.40' })).status).toBe(
      429
    );

    // The account the forged token named still has its whole allowance.
    expect((await ping(app, { bearer: token('victim'), ip: '203.0.113.40' })).status).toBe(200);
  });

  it('falls back to req.ip when CF-Connecting-IP is missing or not an address', async () => {
    const app = freshApp();
    expect((await ping(app)).status).toBe(200);
    expect((await ping(app, { ip: 'not-an-ip' })).status).toBe(200);

    expect((await ping(app)).status).toBe(429);
  });
});

describe('authLimiter', () => {
  const login = (app, { bearer, ip }) => {
    const req = request(app).post('/api/auth/login').set('CF-Connecting-IP', ip);
    if (bearer) req.set('Authorization', `Bearer ${bearer}`);
    return req;
  };

  it('keys on the client address only, whatever account is signed in', async () => {
    const app = freshApp();
    expect((await login(app, { bearer: token('a'), ip: '203.0.113.50' })).status).toBe(200);
    expect((await login(app, { bearer: token('b'), ip: '203.0.113.50' })).status).toBe(200);
    expect((await login(app, { bearer: token('c'), ip: '203.0.113.50' })).status).toBe(429);

    expect((await login(app, { ip: '198.51.100.50' })).status).toBe(200);
  });
});
