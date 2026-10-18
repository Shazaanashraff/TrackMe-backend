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

  it.each(['https://pingo.lk', 'https://www.pingo.lk', 'https://admin.pingo.lk'])(
    'always allows the pingo.lk production origin %s',
    async (origin) => {
      const res = await request(app).get('/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  );

  it.each(['http://pingo.lk', 'https://pingo.lk.evil.com', 'https://evilpingo.lk'])(
    'rejects look-alike origin %s',
    async (origin) => {
      const res = await request(app).get('/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  );

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

describe('Socket.IO handshake origin', () => {
  const { io: ioClient } = require('socket.io-client');
  const { server } = require('../../src/server');
  let port;

  beforeAll(async () => {
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  // Resolves with the handshake's connect_error message. A dummy token gets as
  // far as auth ("Invalid token: jwt malformed"); an origin the CORS check
  // refuses never reaches auth and fails the WebSocket upgrade instead.
  const handshake = (origin) =>
    new Promise((resolve) => {
      const client = ioClient(`http://localhost:${port}`, {
        transports: ['websocket'],
        auth: { token: 'not-a-real-token' },
        reconnection: false,
        forceNew: true,
        ...(origin ? { extraHeaders: { origin } } : {}),
      });
      client.on('connect_error', (error) => {
        client.close();
        resolve(error.message);
      });
    });

  it('lets a same-origin handshake reach auth, which is what the React Native apps send', async () => {
    expect(await handshake(`http://localhost:${port}`)).toBe('Invalid token: jwt malformed');
  });

  it.each([
    ['an allowlisted origin', 'https://allowed.example.com'],
    ['the pingo.lk production origin', 'https://admin.pingo.lk'],
  ])('lets %s reach auth', async (_label, origin) => {
    expect(await handshake(origin)).toBe('Invalid token: jwt malformed');
  });

  it('lets a handshake with no Origin reach auth', async () => {
    expect(await handshake()).toBe('Invalid token: jwt malformed');
  });

  it('refuses a foreign origin before auth', async () => {
    expect(await handshake('https://evil.example.com')).toBe('websocket error');
  });

  it('refuses an origin that only borrows the host name inside a longer one', async () => {
    expect(await handshake(`http://localhost.evil.example.com:${port}`)).toBe('websocket error');
  });
});
