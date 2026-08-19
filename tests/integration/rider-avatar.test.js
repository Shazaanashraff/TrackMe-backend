const request = require('supertest');
const app = require('../../src/server');
const RiderProfile = require('../../src/models/RiderProfile');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const { createRider, authHeader } = require('./factories');

// A rider's picture: stored on the rider, fetched one rider at a time, and
// versioned so a client can cache it.
//
// The picture is deliberately absent from GET /api/riders. Putting it there would
// send every rider's image on every list load, which is the same reason managed
// profiles keep theirs off their own list (docs/modules/PROFILES.md).

// A one-pixel PNG, which is a real image as far as the validator is concerned.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const OVERSIZED = `data:image/png;base64,${'A'.repeat(700 * 1024)}`;

let account;
let auth;
let riderId;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  account = await createRider({ name: 'Account Holder', fields: { phoneNumber: '0771111111' } });
  auth = authHeader(account.token);

  const list = await request(app).get('/api/riders').set(...auth);
  riderId = list.body.data[0]._id;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

const setAvatar = (avatarUrl) => request(app).patch(`/api/riders/${riderId}`).set(...auth).send({ avatarUrl });
const readAvatar = () => request(app).get(`/api/riders/${riderId}/avatar`).set(...auth);
const listRiders = () => request(app).get('/api/riders').set(...auth);

describe('a rider picture', () => {
  test('starts absent, and the list says so without carrying an image', async () => {
    const res = await listRiders();

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ hasAvatar: false, avatarVersion: 0 });
    // The regression this guards: an image inlined here rides along on every load.
    expect(res.body.data[0]).not.toHaveProperty('avatarUrl');
  });

  test('is saved on the rider and read back from its own address', async () => {
    const saved = await setAvatar(PNG);
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ hasAvatar: true, avatarVersion: 1 });

    const fetched = await readAvatar();
    expect(fetched.status).toBe(200);
    expect(fetched.body.data.avatarUrl).toBe(PNG);
  });

  test('the list still refuses to carry the image itself', async () => {
    const res = await listRiders();
    expect(res.body.data[0]).toMatchObject({ hasAvatar: true, avatarVersion: 1 });
    expect(res.body.data[0]).not.toHaveProperty('avatarUrl');
    expect(JSON.stringify(res.body)).not.toContain('base64');
  });

  // The version is what lets a client cache the picture and still notice a change.
  test('the version moves on a change and on a clear', async () => {
    const changed = await setAvatar(PNG.replace('AAAA', 'AAAB'));
    expect(changed.body.data.avatarVersion).toBe(2);

    const cleared = await setAvatar('');
    expect(cleared.body.data).toMatchObject({ hasAvatar: false, avatarVersion: 3 });
    expect((await readAvatar()).body.data.avatarUrl).toBe('');

    const stored = await RiderProfile.findById(riderId);
    expect(stored.avatarUrl).toBe('');
  });

  test('refuses something that is not an image, and something too large', async () => {
    const notAnImage = await setAvatar('data:text/html;base64,PHNjcmlwdD4=');
    expect(notAnImage.status).toBe(400);

    const tooBig = await setAvatar(OVERSIZED);
    expect(tooBig.status).toBe(413);

    // Neither attempt touched the rider.
    const stored = await RiderProfile.findById(riderId);
    expect(stored.avatarUrl).toBe('');
    expect(stored.avatarVersion).toBe(3);
  });

  test('a rider can be created with a picture, and it is validated the same way', async () => {
    const created = await request(app).post('/api/riders').set(...auth).send({
      fullName: 'Amaya', contactPhone: '0772222222', avatarUrl: PNG
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ hasAvatar: true, avatarVersion: 1 });

    const refused = await request(app).post('/api/riders').set(...auth).send({
      fullName: 'Nuwan', contactPhone: '0773333333', avatarUrl: OVERSIZED
    });
    expect(refused.status).toBe(413);
  });

  test("another account cannot read someone else's picture", async () => {
    await setAvatar(PNG);
    const stranger = await createRider({ name: 'Stranger' });

    const res = await request(app)
      .get(`/api/riders/${riderId}/avatar`)
      .set(...authHeader(stranger.token));

    expect(res.status).toBe(404);
  });
});
