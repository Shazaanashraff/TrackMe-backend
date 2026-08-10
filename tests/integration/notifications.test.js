const request = require('supertest');
const app = require('../../src/server');
const Notification = require('../../src/models/Notification');
const { createIdentityWithProfile } = require('../../src/utils/identityRegistry');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// DELETE /api/notifications/admin/cleanup — see docs/modules/NOTIFICATIONS.md. This was
// found to have no role check at all despite being commented "admin only"; covers the
// role guard (401/403/200) and that the delete is global, not scoped to the caller.
//
// Also covers /api/notifications ownership checks (IDOR regression — see issue #1):
// getNotificationById, markAsRead, and deleteNotification must scope by the
// caller's userId, not just the notification's existence.

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

let tokenA;
let userAId, userBId;
let notifA, notifB;

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

  const userA = await createLogin('user', 'Notif User A');
  userAId = userA.id;
  tokenA = userA.token;

  const userB = await createLogin('user', 'Notif User B');
  userBId = userB.id;
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

describe('Notifications ownership (IDOR)', () => {
  beforeEach(async () => {
    notifA = await Notification.create({
      userId: userAId, type: 'SYSTEM_ALERT', title: 'A title', message: 'A message'
    });
    notifB = await Notification.create({
      userId: userBId, type: 'SYSTEM_ALERT', title: 'B title', message: 'B message'
    });
  });

  it('GET /api/notifications/:id returns 404 for another user\'s notification', async () => {
    const res = await request(app)
      .get(`/api/notifications/${notifB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
  });

  it('GET /api/notifications/:id returns the caller\'s own notification', async () => {
    const res = await request(app)
      .get(`/api/notifications/${notifA._id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.data._id).toBe(String(notifA._id));
  });

  it('PUT /api/notifications/:id/read returns 404 and does not mutate another user\'s notification', async () => {
    const res = await request(app)
      .put(`/api/notifications/${notifB._id}/read`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);

    const stored = await Notification.findById(notifB._id);
    expect(stored.isRead).toBe(false);
  });

  it('PUT /api/notifications/:id/read marks the caller\'s own notification as read', async () => {
    const res = await request(app)
      .put(`/api/notifications/${notifA._id}/read`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.data.isRead).toBe(true);
  });

  it('DELETE /api/notifications/:id returns 404 and does not delete another user\'s notification', async () => {
    const res = await request(app)
      .delete(`/api/notifications/${notifB._id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(404);

    const stored = await Notification.findById(notifB._id);
    expect(stored).not.toBeNull();
  });

  it('DELETE /api/notifications/:id deletes the caller\'s own notification', async () => {
    const res = await request(app)
      .delete(`/api/notifications/${notifA._id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);

    const stored = await Notification.findById(notifA._id);
    expect(stored).toBeNull();
  });
});

describe('GET /api/notifications/count/unread', () => {
  // Dedicated users (rather than userA/userB above) so this block's counts
  // aren't affected by notifications the IDOR tests above already read/deleted.
  it('returns 0 when the caller has no unread notifications', async () => {
    const noUnread = await createLogin('user', 'No Unread User');

    const res = await request(app)
      .get('/api/notifications/count/unread')
      .set('Authorization', `Bearer ${noUnread.token}`);

    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(0);
  });

  it('is scoped to the caller — does not count another user\'s unread notifications', async () => {
    const userX = await createLogin('user', 'Unread User X');
    const userY = await createLogin('user', 'Unread User Y');

    await Notification.create([
      { userId: userX.id, type: 'SYSTEM_ALERT', title: 'X1', message: 'm', isRead: false },
      { userId: userX.id, type: 'SYSTEM_ALERT', title: 'X2', message: 'm', isRead: false },
      { userId: userX.id, type: 'SYSTEM_ALERT', title: 'X3 (read)', message: 'm', isRead: true },
      { userId: userY.id, type: 'SYSTEM_ALERT', title: 'Y1', message: 'm', isRead: false }
    ]);

    const resX = await request(app)
      .get('/api/notifications/count/unread')
      .set('Authorization', `Bearer ${userX.token}`);
    expect(resX.status).toBe(200);
    expect(resX.body.unreadCount).toBe(2);

    const resY = await request(app)
      .get('/api/notifications/count/unread')
      .set('Authorization', `Bearer ${userY.token}`);
    expect(resY.status).toBe(200);
    expect(resY.body.unreadCount).toBe(1);
  });
});
