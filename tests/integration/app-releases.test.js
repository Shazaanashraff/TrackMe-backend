const request = require('supertest');

// notificationHelper.notifyAppUpdateAvailable is mocked so publish tests don't
// depend on Expo delivery or walking every User/Driver document — the
// notification/push mechanics themselves are covered by push-helper tests and
// the unit test below.
jest.mock('../../src/utils/notificationHelper', () => {
  const actual = jest.requireActual('../../src/utils/notificationHelper');
  return {
    ...actual,
    notifyAppUpdateAvailable: jest.fn().mockResolvedValue({ notified: 0, sent: 0 })
  };
});

const app = require('../../src/server');
const AppRelease = require('../../src/models/AppRelease');
const { notifyAppUpdateAvailable } = require('../../src/utils/notificationHelper');
const { createIdentityWithProfile } = require('../../src/utils/identityRegistry');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// App release / version-control feature — see docs/modules/APP_RELEASES.md.
// Covers: public read endpoints, super-admin-only write endpoints, the
// deactivate-previous-active-on-publish rule, and the iOS-only notification hook.

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body.accessToken;
}

async function createLogin(role, name) {
  const email = `apprelease-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
  const password = 'P@ssw0rd!';
  const { doc } = await createIdentityWithProfile({
    email, password, isEmailVerified: true, role, fields: { name }
  });
  const token = await loginAs(email, password);
  return { id: doc._id, token };
}

let superAdminToken;
let managerToken;
let riderToken;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const superAdmin = await createLogin('super-admin', 'AppRelease Super Admin');
  superAdminToken = superAdmin.token;

  const manager = await createLogin('admin', 'AppRelease Manager');
  managerToken = manager.token;

  const rider = await createLogin('user', 'AppRelease Rider');
  riderToken = rider.token;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

afterEach(async () => {
  await AppRelease.deleteMany({});
  notifyAppUpdateAvailable.mockClear();
});

function validPayload(overrides = {}) {
  return {
    app: 'driver',
    platform: 'android',
    version: '1.0.1',
    versionCode: 101,
    downloadUrl: 'https://example.com/driver-1.0.1.apk',
    releaseNotes: 'Bug fixes',
    mandatory: false,
    fileSizeBytes: 12345,
    ...overrides
  };
}

describe('AppRelease model validation', () => {
  it('rejects a document missing required fields', async () => {
    await expect(AppRelease.create({})).rejects.toThrow();
  });

  it('rejects an invalid app enum value', async () => {
    await expect(AppRelease.create({
      app: 'passenger', platform: 'android', version: '1.0.0', versionCode: 1, downloadUrl: 'x'
    })).rejects.toThrow();
  });

  it('rejects an invalid platform enum value', async () => {
    await expect(AppRelease.create({
      app: 'driver', platform: 'windows', version: '1.0.0', versionCode: 1, downloadUrl: 'x'
    })).rejects.toThrow();
  });

  it('creates a valid document with defaults applied', async () => {
    const doc = await AppRelease.create({
      app: 'rider', platform: 'ios', version: '2.0.0', versionCode: 1, downloadUrl: 'https://x.test/app'
    });
    expect(doc.releaseNotes).toBe('');
    expect(doc.mandatory).toBe(false);
    expect(doc.isActive).toBe(true);
  });
});

describe('GET /api/app-releases', () => {
  it('is public (no auth required)', async () => {
    const res = await request(app).get('/api/app-releases');
    expect(res.status).toBe(200);
    expect(res.body.releases).toEqual([]);
  });

  it('returns only the latest active release per (app, platform) pair', async () => {
    await AppRelease.create({ app: 'driver', platform: 'android', version: '1.0.0', versionCode: 1, downloadUrl: 'x', isActive: false });
    const latestDriverAndroid = await AppRelease.create({ app: 'driver', platform: 'android', version: '1.0.1', versionCode: 2, downloadUrl: 'x', isActive: true });
    await AppRelease.create({ app: 'driver', platform: 'ios', version: '1.0.0', versionCode: 1, downloadUrl: 'x', isActive: true });
    const latestRiderAndroid = await AppRelease.create({ app: 'rider', platform: 'android', version: '3.0.0', versionCode: 5, downloadUrl: 'x', isActive: true });

    const res = await request(app).get('/api/app-releases');
    expect(res.status).toBe(200);
    expect(res.body.releases).toHaveLength(3);

    const byKey = {};
    res.body.releases.forEach((r) => { byKey[`${r.app}:${r.platform}`] = r; });
    expect(byKey['driver:android']._id).toBe(String(latestDriverAndroid._id));
    expect(byKey['rider:android']._id).toBe(String(latestRiderAndroid._id));
  });
});

describe('GET /api/app-releases/latest', () => {
  it('is public (no auth required)', async () => {
    const res = await request(app).get('/api/app-releases/latest').query({ app: 'driver', platform: 'android' });
    expect(res.status).toBe(200);
  });

  it('400s when app is missing or invalid', async () => {
    const missing = await request(app).get('/api/app-releases/latest').query({ platform: 'android' });
    expect(missing.status).toBe(400);

    const invalid = await request(app).get('/api/app-releases/latest').query({ app: 'nope', platform: 'android' });
    expect(invalid.status).toBe(400);
  });

  it('400s when platform is missing or invalid', async () => {
    const missing = await request(app).get('/api/app-releases/latest').query({ app: 'driver' });
    expect(missing.status).toBe(400);

    const invalid = await request(app).get('/api/app-releases/latest').query({ app: 'driver', platform: 'windows' });
    expect(invalid.status).toBe(400);
  });

  it('returns null when nothing matches', async () => {
    const res = await request(app).get('/api/app-releases/latest').query({ app: 'driver', platform: 'ios' });
    expect(res.status).toBe(200);
    expect(res.body.release).toBeNull();
  });

  it('returns the newest active matching document', async () => {
    await AppRelease.create({ app: 'driver', platform: 'android', version: '1.0.0', versionCode: 1, downloadUrl: 'x', isActive: false });
    const newest = await AppRelease.create({ app: 'driver', platform: 'android', version: '1.0.1', versionCode: 2, downloadUrl: 'x', isActive: true });

    const res = await request(app).get('/api/app-releases/latest').query({ app: 'driver', platform: 'android' });
    expect(res.status).toBe(200);
    expect(res.body.release._id).toBe(String(newest._id));
  });
});

describe('GET /api/app-releases/history', () => {
  it('401s with no auth', async () => {
    const res = await request(app).get('/api/app-releases/history').query({ app: 'driver' });
    expect(res.status).toBe(401);
  });

  it('403s for a non-super-admin role', async () => {
    const res = await request(app)
      .get('/api/app-releases/history')
      .query({ app: 'driver' })
      .set('Authorization', `Bearer ${managerToken}`);
    expect(res.status).toBe(403);

    const riderRes = await request(app)
      .get('/api/app-releases/history')
      .query({ app: 'driver' })
      .set('Authorization', `Bearer ${riderToken}`);
    expect(riderRes.status).toBe(403);
  });

  it('400s when app is missing or invalid', async () => {
    const missing = await request(app)
      .get('/api/app-releases/history')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(missing.status).toBe(400);

    const invalid = await request(app)
      .get('/api/app-releases/history')
      .query({ app: 'nope' })
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(invalid.status).toBe(400);
  });

  it('returns all docs (active or not) for the app, newest first', async () => {
    const first = await AppRelease.create({ app: 'driver', platform: 'android', version: '1.0.0', versionCode: 1, downloadUrl: 'x', isActive: false });
    const second = await AppRelease.create({ app: 'driver', platform: 'android', version: '1.0.1', versionCode: 2, downloadUrl: 'x', isActive: true });
    await AppRelease.create({ app: 'rider', platform: 'android', version: '1.0.0', versionCode: 1, downloadUrl: 'x', isActive: true });

    const res = await request(app)
      .get('/api/app-releases/history')
      .query({ app: 'driver' })
      .set('Authorization', `Bearer ${superAdminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.releases).toHaveLength(2);
    expect(res.body.releases[0]._id).toBe(String(second._id));
    expect(res.body.releases[1]._id).toBe(String(first._id));
  });
});

describe('POST /api/app-releases', () => {
  it('401s with no auth', async () => {
    const res = await request(app).post('/api/app-releases').send(validPayload());
    expect(res.status).toBe(401);
  });

  it('403s for a non-super-admin role', async () => {
    const res = await request(app)
      .post('/api/app-releases')
      .set('Authorization', `Bearer ${managerToken}`)
      .send(validPayload());
    expect(res.status).toBe(403);

    const riderRes = await request(app)
      .post('/api/app-releases')
      .set('Authorization', `Bearer ${riderToken}`)
      .send(validPayload());
    expect(riderRes.status).toBe(403);
  });

  it('400s on invalid/missing fields', async () => {
    const cases = [
      { app: 'nope' },
      { platform: 'windows' },
      { version: undefined },
      { versionCode: 'not-a-number' },
      { downloadUrl: '' }
    ];
    for (const override of cases) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .post('/api/app-releases')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(validPayload(override));
      expect(res.status).toBe(400);
    }
  });

  it('creates a release and returns 201', async () => {
    const res = await request(app)
      .post('/api/app-releases')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(validPayload());

    expect(res.status).toBe(201);
    expect(res.body.data.app).toBe('driver');
    expect(res.body.data.isActive).toBe(true);
  });

  it('deactivates the prior active release for the same app+platform', async () => {
    const first = await request(app)
      .post('/api/app-releases')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(validPayload({ version: '1.0.0', versionCode: 100 }));
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/app-releases')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(validPayload({ version: '1.0.1', versionCode: 101 }));
    expect(second.status).toBe(201);

    const reloadedFirst = await AppRelease.findById(first.body.data._id);
    expect(reloadedFirst.isActive).toBe(false);

    const reloadedSecond = await AppRelease.findById(second.body.data._id);
    expect(reloadedSecond.isActive).toBe(true);
  });

  it('does not disturb a different platform\'s active release for the same app', async () => {
    const androidRelease = await request(app)
      .post('/api/app-releases')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(validPayload({ platform: 'android' }));
    expect(androidRelease.status).toBe(201);

    const iosRelease = await request(app)
      .post('/api/app-releases')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(validPayload({ platform: 'ios', versionCode: 1 }));
    expect(iosRelease.status).toBe(201);

    const reloadedAndroid = await AppRelease.findById(androidRelease.body.data._id);
    expect(reloadedAndroid.isActive).toBe(true);
  });

  it('triggers the notification helper for platform:ios', async () => {
    const res = await request(app)
      .post('/api/app-releases')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(validPayload({ platform: 'ios', versionCode: 1, version: '1.2.0' }));

    expect(res.status).toBe(201);
    expect(notifyAppUpdateAvailable).toHaveBeenCalledTimes(1);
    expect(notifyAppUpdateAvailable).toHaveBeenCalledWith({
      app: 'driver',
      version: '1.2.0',
      downloadUrl: expect.any(String)
    });
  });

  it('does not trigger the notification helper for platform:android', async () => {
    const res = await request(app)
      .post('/api/app-releases')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(validPayload({ platform: 'android' }));

    expect(res.status).toBe(201);
    expect(notifyAppUpdateAvailable).not.toHaveBeenCalled();
  });

  it('still returns 201 even if the notification helper throws', async () => {
    notifyAppUpdateAvailable.mockRejectedValueOnce(new Error('expo down'));

    const res = await request(app)
      .post('/api/app-releases')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(validPayload({ platform: 'ios', versionCode: 1 }));

    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/app-releases/:id', () => {
  it('401s with no auth', async () => {
    const release = await AppRelease.create({ app: 'driver', platform: 'android', version: '1.0.0', versionCode: 1, downloadUrl: 'x' });
    const res = await request(app).patch(`/api/app-releases/${release._id}`).send({ isActive: false });
    expect(res.status).toBe(401);
  });

  it('403s for a non-super-admin role', async () => {
    const release = await AppRelease.create({ app: 'driver', platform: 'android', version: '1.0.0', versionCode: 1, downloadUrl: 'x' });
    const res = await request(app)
      .patch(`/api/app-releases/${release._id}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ isActive: false });
    expect(res.status).toBe(403);
  });

  it('404s for an unknown id', async () => {
    const res = await request(app)
      .patch('/api/app-releases/000000000000000000000000')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ isActive: false });
    expect(res.status).toBe(404);
  });

  it('toggles isActive', async () => {
    const release = await AppRelease.create({ app: 'driver', platform: 'android', version: '1.0.0', versionCode: 1, downloadUrl: 'x', isActive: true });

    const off = await request(app)
      .patch(`/api/app-releases/${release._id}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);

    const on = await request(app)
      .patch(`/api/app-releases/${release._id}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ isActive: true });
    expect(on.status).toBe(200);
    expect(on.body.data.isActive).toBe(true);
  });
});
