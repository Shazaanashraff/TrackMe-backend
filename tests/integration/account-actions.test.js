// Every request here comes from one address, and this suite makes more than the
// 100-per-15-minutes auth ceiling (middleware/rateLimiters.js). Lift it before
// the server loads, as auth-ip-rate-limit.test.js does; the per-login limiters
// under test are separate.
process.env.AUTH_IP_RATE_LIMIT_MAX = '1000';

const request = require('supertest');
const app = require('../../src/server');
const Identity = require('../../src/models/Identity');
const User = require('../../src/models/User');
const Driver = require('../../src/models/Driver');
const RiderProfile = require('../../src/models/RiderProfile');
const DriverEnrollment = require('../../src/models/DriverEnrollment');
const HouseholdPlace = require('../../src/models/HouseholdPlace');
const Notification = require('../../src/models/Notification');
const BoardingEvent = require('../../src/models/BoardingEvent');
const { Message, Conversation } = require('../../src/models/Communication');
const { createIdentityWithProfile, attachProfile } = require('../../src/utils/identityRegistry');
const { issueTokensForUser } = require('../../src/utils/tokens');
const { ensureLegacyRider } = require('../../src/utils/riders');
const { dispatch } = require('../../src/services/communications');
const accountDeletion = require('../../src/services/accountDeletion');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');
const {
  createRider, createDriver, createManager, uniqueEmail, login, authHeader, DEFAULT_PASSWORD
} = require('./factories');

// Change password and delete account (rider app Profile, issues #58 and #59).
//
// No mail provider is configured in tests (tests/jest.setup.js), so the code
// endpoint answers with `developmentOtp`. Each scenario uses its own account:
// code requests are limited to 3 per 10 minutes per login.

const NEW_PASSWORD = 'N3w!Passw0rd';

async function requestCode(token, purpose) {
  const res = await request(app).post('/api/auth/account-code').set(...authHeader(token)).send({ purpose });
  expect(res.status).toBe(200);
  expect(res.body.developmentOtp).toMatch(/^\d{6}$/);
  return res.body.developmentOtp;
}

// A rider, their own rider row, and enrollments with a manager's driver: one
// ACTIVE (with a chat thread) and one PENDING with a second driver.
async function riderOnShuttles() {
  const manager = await createManager({ name: 'Grace Manager' });
  const activeDriverAccount = await createDriver({ name: 'Active Driver', fields: { managerId: manager.id } });
  const pendingDriverAccount = await createDriver({ name: 'Pending Driver', fields: { managerId: manager.id } });
  const rider = await createRider({ name: 'Amal Perera' });
  const riderRow = await ensureLegacyRider(rider.doc);
  const active = await DriverEnrollment.create({
    studentId: riderRow._id, driverId: activeDriverAccount.id, managerId: manager.id, status: 'ACTIVE'
  });
  const pending = await DriverEnrollment.create({
    studentId: riderRow._id, driverId: pendingDriverAccount.id, managerId: manager.id, status: 'PENDING', requiredApproval: true
  });
  return { manager, activeDriverAccount, pendingDriverAccount, rider, riderRow, active, pending };
}

async function scheduleDeletion(token) {
  const code = await requestCode(token, 'DELETE_ACCOUNT');
  const res = await request(app).post('/api/auth/delete-account').set(...authHeader(token)).send({ code });
  expect(res.status).toBe(200);
  return res;
}

beforeAll(async () => {
  await connectTestDb();
  await clearTestDb();
  await User.syncIndexes();
});

afterAll(async () => {
  await closeTestDb();
});

describe('POST /api/auth/account-code', () => {
  it('needs a signed-in rider', async () => {
    const anonymous = await request(app).post('/api/auth/account-code').send({ purpose: 'CHANGE_PASSWORD' });
    expect(anonymous.status).toBe(401);

    const driver = await createDriver();
    const asDriver = await request(app).post('/api/auth/account-code').set(...authHeader(driver.token)).send({ purpose: 'CHANGE_PASSWORD' });
    expect(asDriver.status).toBe(403);
  });

  it('rejects an unknown purpose', async () => {
    const rider = await createRider();
    const res = await request(app).post('/api/auth/account-code').set(...authHeader(rider.token)).send({ purpose: 'SOMETHING' });
    expect(res.status).toBe(400);
  });

  it('refuses a password code for a Google-only login (409 NO_PASSWORD)', async () => {
    const email = uniqueEmail('google-only');
    const { doc } = await createIdentityWithProfile({
      email, googleId: `g-${Date.now()}`, isEmailVerified: true, role: 'user', fields: { name: 'Google Rider' }
    });
    const { accessToken } = await issueTokensForUser(doc, 'user');

    const me = await request(app).get('/api/auth/me').set(...authHeader(accessToken));
    expect(me.body.user.hasPassword).toBe(false);

    const res = await request(app).post('/api/auth/account-code').set(...authHeader(accessToken)).send({ purpose: 'CHANGE_PASSWORD' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_PASSWORD');
  });

  it('allows 3 requests per 10 minutes per login', async () => {
    const rider = await createRider();
    for (let i = 0; i < 3; i += 1) await requestCode(rider.token, 'CHANGE_PASSWORD');
    const fourth = await request(app).post('/api/auth/account-code').set(...authHeader(rider.token)).send({ purpose: 'CHANGE_PASSWORD' });
    expect(fourth.status).toBe(429);
  });
});

// Change password checks the code first: verify spends it and hands back a
// token, and the new password goes with that token.
const verifyCode = (token, code, purpose = 'CHANGE_PASSWORD') =>
  request(app).post('/api/auth/account-code/verify').set(...authHeader(token)).send({ purpose, code });

async function changeToken(token) {
  const code = await requestCode(token, 'CHANGE_PASSWORD');
  const res = await verifyCode(token, code);
  expect(res.status).toBe(200);
  expect(res.body.token).toMatch(/^[0-9a-f]{64}$/);
  return res.body.token;
}

const changePassword = (token, body) =>
  request(app).post('/api/auth/change-password').set(...authHeader(token)).send(body);

describe('POST /api/auth/account-code/verify', () => {
  it('needs a signed-in rider', async () => {
    expect((await request(app).post('/api/auth/account-code/verify').send({ purpose: 'CHANGE_PASSWORD', code: '123456' })).status).toBe(401);
    const driver = await createDriver();
    expect((await verifyCode(driver.token, '123456')).status).toBe(403);
  });

  it('refuses a wrong code and wipes the code on the 5th wrong try', async () => {
    const rider = await createRider();
    const code = await requestCode(rider.token, 'CHANGE_PASSWORD');
    const wrong = code === '111111' ? '222222' : '111111';

    for (let i = 0; i < 4; i += 1) {
      const res = await verifyCode(rider.token, wrong);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CODE');
      expect(res.body.token).toBeUndefined();
    }
    const fifth = await verifyCode(rider.token, wrong);
    expect(fifth.body.message).toMatch(/Too many invalid attempts/);

    // The right code no longer works either.
    expect((await verifyCode(rider.token, code)).status).toBe(400);
  });

  it('refuses an expired code', async () => {
    const rider = await createRider();
    const code = await requestCode(rider.token, 'CHANGE_PASSWORD');
    await Identity.updateOne({ _id: rider.identity._id }, { $set: { 'accountCode.expiresAt': new Date(Date.now() - 1000) } });

    const res = await verifyCode(rider.token, code);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/expired/);
  });

  it('does not accept a code that was sent for account deletion, or a DELETE_ACCOUNT purpose', async () => {
    const rider = await createRider();
    const code = await requestCode(rider.token, 'DELETE_ACCOUNT');
    expect((await verifyCode(rider.token, code)).status).toBe(400);
    expect((await verifyCode(rider.token, code, 'DELETE_ACCOUNT')).status).toBe(400);
  });

  it('refuses a Google-only login (409 NO_PASSWORD)', async () => {
    const { doc } = await createIdentityWithProfile({
      email: uniqueEmail('google-verify'), googleId: `g-verify-${Date.now()}`, isEmailVerified: true, role: 'user', fields: { name: 'Google Rider' }
    });
    const { accessToken } = await issueTokensForUser(doc, 'user');
    const res = await verifyCode(accessToken, '123456');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_PASSWORD');
  });
});

describe('POST /api/auth/change-password', () => {
  it('changes the password, keeps the caller signed in and ends every other session at once', async () => {
    const rider = await createRider();
    // A second device: another sign-in of the same rider, then a driver role on the same login.
    const driverProfile = await attachProfile({ identityId: rider.identity._id, role: 'driver', fields: { name: 'Same Person Driving' } });
    const driverTokens = await issueTokensForUser(driverProfile.doc, 'driver');
    expect((await request(app).get('/api/auth/me').set(...authHeader(driverTokens.accessToken))).status).toBe(200);

    const me = await request(app).get('/api/auth/me').set(...authHeader(rider.token));
    expect(me.body.user.hasPassword).toBe(true);

    const token = await changeToken(rider.token);
    const res = await changePassword(rider.token, { token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();

    // The old access token dies now, not in 15 minutes; so does the other role's.
    const stale = await request(app).get('/api/auth/me').set(...authHeader(rider.token));
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('SESSION_REVOKED');
    expect((await request(app).get('/api/auth/me').set(...authHeader(driverTokens.accessToken))).status).toBe(401);
    const staleRefresh = await request(app).post('/api/auth/refresh-token').send({ refreshToken: driverTokens.refreshToken });
    expect(staleRefresh.status).toBe(401);

    // The caller's fresh pair works.
    expect((await request(app).get('/api/auth/me').set(...authHeader(res.body.accessToken))).status).toBe(200);
    const refreshed = await request(app).post('/api/auth/refresh-token').send({ refreshToken: res.body.refreshToken });
    expect(refreshed.status).toBe(200);

    expect((await login(rider.email, DEFAULT_PASSWORD, 'user')).status).toBe(401);
    expect((await login(rider.email, NEW_PASSWORD, 'user')).status).toBe(200);
  });

  it('refuses a wrong token, and the code itself in place of the token (400 INVALID_TOKEN)', async () => {
    const rider = await createRider();
    await changeToken(rider.token);
    const wrong = await changePassword(rider.token, { token: 'f'.repeat(64), password: NEW_PASSWORD });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('INVALID_TOKEN');

    const code = await requestCode(rider.token, 'CHANGE_PASSWORD');
    expect((await changePassword(rider.token, { token: code, password: NEW_PASSWORD })).status).toBe(400);
    expect((await login(rider.email, DEFAULT_PASSWORD, 'user')).status).toBe(200);
  });

  it('refuses an expired token', async () => {
    const rider = await createRider();
    const token = await changeToken(rider.token);
    await Identity.updateOne({ _id: rider.identity._id }, { $set: { 'accountCode.tokenExpiresAt': new Date(Date.now() - 1000) } });

    const res = await changePassword(rider.token, { token, password: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TOKEN');
    expect(res.body.message).toMatch(/new code/);
  });

  it('a token works once', async () => {
    const rider = await createRider();
    const token = await changeToken(rider.token);
    const first = await changePassword(rider.token, { token, password: NEW_PASSWORD });
    expect(first.status).toBe(200);

    const again = await changePassword(first.body.accessToken, { token, password: 'An0ther!Pass' });
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('INVALID_TOKEN');
  });

  it('enforces the password policy and needs a token', async () => {
    const rider = await createRider();
    const token = await changeToken(rider.token);
    expect((await changePassword(rider.token, { token, password: 'weak' })).status).toBe(400);
    expect((await changePassword(rider.token, { password: NEW_PASSWORD })).status).toBe(400);
  });
});

describe('POST /api/auth/delete-account', () => {
  it('ends enrollments, signs the rider out, and tells the driver and manager', async () => {
    const { manager, activeDriverAccount, rider, riderRow, active, pending } = await riderOnShuttles();
    await User.updateOne({ _id: rider.id }, { $set: { pushTokens: ['ExponentPushToken[test]'] } });

    const res = await scheduleDeletion(rider.token);
    const purgeAt = new Date(res.body.purgeAt).getTime();
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    expect(Math.abs(purgeAt - (Date.now() + threeDays))).toBeLessThan(60 * 1000);

    expect(await DriverEnrollment.countDocuments({ _id: { $in: [active._id, pending._id] } })).toBe(0);
    const primary = await User.findById(rider.id).select('+deletion.enrollmentSnapshot');
    expect(primary.deletion.enrollmentSnapshot).toHaveLength(2);
    expect(primary.pushTokens).toEqual([]);

    expect((await request(app).get('/api/auth/me').set(...authHeader(rider.token))).status).toBe(401);

    // Driver: a driver-only system message in the rider's thread (only for the ACTIVE row).
    const thread = await Conversation.findOne({ riderId: riderRow._id, driverId: activeDriverAccount.id });
    const notice = await Message.findOne({ conversationId: thread._id, sender: 'system' });
    expect(notice.driverOnly).toBe(true);
    expect(notice.text).toMatch(/Amal Perera left your shuttle/);
    await dispatch(null, { retire: false });
    expect(await Notification.countDocuments({ eventId: `${notice.eventId}:driver` })).toBe(1);
    expect(await Notification.countDocuments({ eventId: `${notice.eventId}:user` })).toBe(0);

    // Manager: one bell notice per ended enrollment, readable through /api/notifications.
    const bell = await request(app).get('/api/notifications').set(...authHeader(manager.token));
    expect(bell.status).toBe(200);
    const types = bell.body.data.map((n) => n.type);
    expect(types.filter((t) => t === 'RIDER_ACCOUNT_DELETED')).toHaveLength(2);
    expect(bell.body.data.some((n) => /withdrew their request/.test(n.message))).toBe(true);
    const unread = await request(app).get('/api/notifications/count/unread').set(...authHeader(manager.token));
    expect(unread.body.unreadCount).toBe(2);
  });

  it('refuses a wrong code and a code sent for a password change', async () => {
    const rider = await createRider();
    const wrong = await request(app).post('/api/auth/delete-account').set(...authHeader(rider.token)).send({ code: '000000' });
    expect(wrong.status).toBe(400);

    const code = await requestCode(rider.token, 'CHANGE_PASSWORD');
    const mixed = await request(app).post('/api/auth/delete-account').set(...authHeader(rider.token)).send({ code });
    expect(mixed.status).toBe(400);
    expect((await User.findById(rider.id)).deletion.purgeAt).toBeNull();
  });

  it('a driver cannot use it (403)', async () => {
    const driver = await createDriver();
    const res = await request(app).post('/api/auth/delete-account').set(...authHeader(driver.token)).send({ code: '123456' });
    expect(res.status).toBe(403);
  });
});

describe('during the grace period', () => {
  it('signing in works, but only the keep-or-continue calls are allowed', async () => {
    const rider = await createRider();
    await scheduleDeletion(rider.token);

    const signIn = await login(rider.email, DEFAULT_PASSWORD, 'user');
    expect(signIn.status).toBe(200);
    expect(signIn.body.user.pendingDeletion.purgeAt).toBeTruthy();
    const token = signIn.body.accessToken;

    expect((await request(app).get('/api/auth/me').set(...authHeader(token))).status).toBe(200);
    const blocked = await request(app).get('/api/riders').set(...authHeader(token));
    expect(blocked.status).toBe(423);
    expect(blocked.body.code).toBe('ACCOUNT_PENDING_DELETION');
  });

  it('blocks registering the same email until the purge (409)', async () => {
    const rider = await createRider();
    await scheduleDeletion(rider.token);

    const res = await request(app).post('/api/auth/register').send({ name: 'Again', email: rider.email, password: NEW_PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ACCOUNT_PENDING_DELETION');
  });

  it('"Keep my account" restores the enrollments and tells the driver and manager', async () => {
    const { manager, activeDriverAccount, rider, riderRow, active, pending } = await riderOnShuttles();
    await scheduleDeletion(rider.token);
    const signIn = await login(rider.email, DEFAULT_PASSWORD, 'user');
    const token = signIn.body.accessToken;

    const res = await request(app).post('/api/auth/delete-account/cancel').set(...authHeader(token));
    expect(res.status).toBe(200);
    expect(res.body.restoredEnrollments).toBe(2);
    expect(res.body.user.pendingDeletion).toBeNull();

    const back = await DriverEnrollment.find({ _id: { $in: [active._id, pending._id] } }).lean();
    expect(back.map((e) => e.status).sort()).toEqual(['ACTIVE', 'PENDING']);

    expect((await request(app).get('/api/riders').set(...authHeader(token))).status).toBe(200);

    const restoredNotices = await Notification.find({ userId: manager.id, type: 'RIDER_ACCOUNT_RESTORED' });
    expect(restoredNotices).toHaveLength(2);
    const thread = await Conversation.findOne({ riderId: riderRow._id, driverId: activeDriverAccount.id });
    expect(await Message.countDocuments({ conversationId: thread._id, text: /is back on your shuttle/ })).toBe(1);

    const again = await request(app).post('/api/auth/delete-account/cancel').set(...authHeader(token));
    expect(again.status).toBe(409);
  });
});

describe('purge', () => {
  it('removes the household, keeps boarding rows without location, and keeps the manager notice anonymised', async () => {
    const { manager, activeDriverAccount, rider, riderRow } = await riderOnShuttles();
    await HouseholdPlace.create({ accountId: rider.id, label: 'Home', address: '1 Lake Road', coordinates: { lat: 6.9, lng: 79.8 } });
    await BoardingEvent.create({
      studentId: riderRow._id, vehicleId: 'VAN-1', routeId: 'R1', driverId: activeDriverAccount.id, type: 'BOARD', lat: 6.9, lng: 79.8
    });
    await Notification.create({ userId: rider.id, type: 'SYSTEM_ALERT', title: 'Hi', message: 'For the rider' });

    await scheduleDeletion(rider.token);
    await User.updateOne({ _id: rider.id }, { $set: { 'deletion.purgeAt': new Date(Date.now() - 1000) } });
    expect(await accountDeletion.purgeDueAccounts()).toBe(1);

    expect(await User.countDocuments({ _id: rider.id })).toBe(0);
    expect(await RiderProfile.countDocuments({ _id: riderRow._id })).toBe(0);
    expect(await Identity.countDocuments({ _id: rider.identity._id })).toBe(0);
    expect(await HouseholdPlace.countDocuments({ accountId: rider.id })).toBe(0);
    expect(await Notification.countDocuments({ userId: rider.id })).toBe(0);
    expect(await Conversation.countDocuments({ riderId: riderRow._id })).toBe(0);

    const event = await BoardingEvent.findOne({ studentId: riderRow._id }).lean();
    expect(event).toBeTruthy();
    expect(event.lat).toBeNull();
    expect(event.lng).toBeNull();

    const managerNotices = await Notification.find({ userId: manager.id, type: 'RIDER_ACCOUNT_DELETED' }).lean();
    expect(managerNotices.length).toBeGreaterThan(0);
    expect(managerNotices.every((n) => n.studentId === null && !/Amal/.test(n.message))).toBe(true);

    // The email is free again.
    const register = await request(app).post('/api/auth/register').send({ name: 'Fresh', email: rider.email, password: NEW_PASSWORD });
    expect(register.status).toBe(201);
  });

  it('signing in after the grace period purges on the spot (410)', async () => {
    const rider = await createRider();
    await scheduleDeletion(rider.token);
    await User.updateOne({ _id: rider.id }, { $set: { 'deletion.purgeAt': new Date(Date.now() - 1000) } });

    const res = await login(rider.email, DEFAULT_PASSWORD, 'user');
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('ACCOUNT_DELETED');
    expect(await User.countDocuments({ _id: rider.id })).toBe(0);
  });

  it('keeps the login and its driver session when the person also drives', async () => {
    const rider = await createRider();
    const driverProfile = await attachProfile({ identityId: rider.identity._id, role: 'driver', fields: { name: 'Still Driving' } });
    const driverTokens = await issueTokensForUser(driverProfile.doc, 'driver');

    await scheduleDeletion(rider.token);
    // Rider sessions end; the driver session is untouched.
    expect((await request(app).get('/api/auth/me').set(...authHeader(driverTokens.accessToken))).status).toBe(200);

    await User.updateOne({ _id: rider.id }, { $set: { 'deletion.purgeAt': new Date(Date.now() - 1000) } });
    await accountDeletion.purgeDueAccounts();

    expect(await User.countDocuments({ _id: rider.id })).toBe(0);
    expect(await Identity.countDocuments({ _id: rider.identity._id })).toBe(1);
    expect(await Driver.countDocuments({ _id: driverProfile.doc._id })).toBe(1);
    expect((await request(app).get('/api/auth/me').set(...authHeader(driverTokens.accessToken))).status).toBe(200);
  });
});
