const request = require('supertest');
const app = require('../../src/server');
const Notification = require('../../src/models/Notification');
const { createIdentityWithProfile } = require('../../src/utils/identityRegistry');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// DELETE /api/notifications/admin/cleanup — see docs/modules/NOTIFICATIONS.md. This was
// found to have no role check at all despite being commented "admin only"; covers the
// role guard (401/403/200) and that the delete is global, not scoped to the caller.

async function loginAs(email, password) {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  return res.body.accessToken;
}

async function createLogin(role, name) {
  const email = `notif-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.com`;
  const password = 'P@ssw0rd!';
  const { doc } = await createIdentityWithProfile({
    email, password, isEmailVerified: true, role, fields: { name }
  });
  const token = await loginAs(email, password);
  return { id: doc._id, token };
}

let riderToken, riderId;
let otherRiderId;
let driverToken;
let managerToken;
let superAdminToken;

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();

  const rider = await createLogin('user', 'Notif Rider');
  riderId = rider.id;
  riderToken = rider.token;

  const otherRider = await createLogin('user', 'Notif Other Rider');
  otherRiderId = otherRider.id;

  const driver = await createLogin('driver', 'Notif Driver');
  driverToken = driver.token;

  const manager = await createLogin('admin', 'Notif Manager');
  managerToken = manager.token;

  const superAdmin = await createLogin('super-admin', 'Notif Super Admin');
  superAdminToken = superAdmin.token;
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

afterEach(async () => {
  await Notification.deleteMany({});
});

describe('DELETE /api/notifications/admin/cleanup', () => {
  async function seedNotifications() {
    const expiredMine = await Notification.create({
      userId: riderId, type: 'SYSTEM_ALERT', title: 'Expired mine', message: 'x',
      expiresAt: new Date(Date.now() - 60_000)
    });
    const expiredOther = await Notification.create({
      userId: otherRiderId, type: 'SYSTEM_ALERT', title: 'Expired other rider', message: 'x',
      expiresAt: new Date(Date.now() - 60_000)
    });
    const notExpired = await Notification.create({
      userId: riderId, type: 'SYSTEM_ALERT', title: 'Still valid', message: 'x',
      expiresAt: new Date(Date.now() + 60_000)
    });
    return { expiredMine, expiredOther, notExpired };
  }

  it('401s an unauthenticated caller', async () => {
    const res = await request(app).delete('/api/notifications/admin/cleanup');
    expect(res.status).toBe(401);
  });

  it('403s a rider', async () => {
    await seedNotifications();
    const res = await request(app)
      .delete('/api/notifications/admin/cleanup')
      .set('Authorization', `Bearer ${riderToken}`);
    expect(res.status).toBe(403);
  });

  it('403s a driver', async () => {
    await seedNotifications();
    const res = await request(app)
      .delete('/api/notifications/admin/cleanup')
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(403);
  });

  it('lets a manager delete expired notifications system-wide, leaving non-expired ones', async () => {
    const { expiredMine, expiredOther, notExpired } = await seedNotifications();

    const res = await request(app)
      .delete('/api/notifications/admin/cleanup')
      .set('Authorization', `Bearer ${managerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deletedCount).toBe(2);

    expect(await Notification.findById(expiredMine._id)).toBeNull();
    expect(await Notification.findById(expiredOther._id)).toBeNull();
    expect(await Notification.findById(notExpired._id)).not.toBeNull();
  });

  it('lets a super-admin call cleanup too', async () => {
    await seedNotifications();
    const res = await request(app)
      .delete('/api/notifications/admin/cleanup')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.deletedCount).toBe(2);
  });
});
