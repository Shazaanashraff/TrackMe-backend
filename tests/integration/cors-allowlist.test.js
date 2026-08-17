// Must be set before src/server is first required — CLIENT_ORIGINS is read once
// at module load time to build the shared allowlist used by both Express CORS
// and Socket.IO CORS.
process.env.CLIENT_ORIGINS = 'https://allowed.example.com,https://also-allowed.example.com';

const request = require('supertest');
const app = require('../../src/server');

describe('CORS allowlist', () => {
  it('sets Access-Control-Allow-Origin for an allowed origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://allowed.example.com');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://allowed.example.com');
  });

  it('omits Access-Control-Allow-Origin for a disallowed origin, without failing the request', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    // The server still answers normally (non-browser callers aren't blocked
    // server-side) — a browser is the one that enforces same-origin policy
    // using the missing header.
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers requests with no Origin header at all (server-to-server, curl, native apps)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});
