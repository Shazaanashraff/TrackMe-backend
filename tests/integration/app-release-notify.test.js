// notifyAppUpdateAvailable — see docs/modules/APP_RELEASES.md §7. Locks the
// actual DB + Expo mechanics that app-releases.test.js mocks out at the
// controller layer: every account of the target app gets a stored
// Notification plus a push to every valid Expo token across those accounts.

jest.mock('expo-server-sdk', () => {
  const sendPushNotificationsAsync = jest.fn().mockResolvedValue([{ status: 'ok', id: 'ticket-1' }]);
  function Expo() {
    return { chunkPushNotifications: (messages) => [messages], sendPushNotificationsAsync };
  }
  Expo.isExpoPushToken = (t) => typeof t === 'string' && t.startsWith('ExponentPushToken');
  return { Expo, __mockSendPushNotificationsAsync: sendPushNotificationsAsync };
});

const User = require('../../src/models/User');
const Driver = require('../../src/models/Driver');
const Notification = require('../../src/models/Notification');
const Identity = require('../../src/models/Identity');
const { notifyAppUpdateAvailable } = require('../../src/utils/notificationHelper');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await clearTestDb();
  await closeTestDb();
});

beforeEach(async () => {
  await clearTestDb();
  jest.clearAllMocks();
});

describe('notifyAppUpdateAvailable', () => {
  it('notifies every rider (User) account for app: "rider" and pushes to valid tokens', async () => {
    const identity1 = await Identity.create({ email: `rel-r1-${Date.now()}@t.com`, password: 'P@ssw0rd!' });
    const rider1 = await User.create({
      name: 'Rider One', identityId: identity1._id, email: identity1.email, profileKind: 'PRIMARY',
      pushTokens: ['ExponentPushToken[valid1]', 'not-a-token']
    });
    const identity2 = await Identity.create({ email: `rel-r2-${Date.now()}@t.com`, password: 'P@ssw0rd!' });
    const rider2 = await User.create({
      name: 'Rider Two', identityId: identity2._id, email: identity2.email, profileKind: 'PRIMARY', pushTokens: []
    });

    const result = await notifyAppUpdateAvailable({ app: 'rider', version: '2.1.0', downloadUrl: 'https://x.test/rider' });

    expect(result.notified).toBe(2);

    const notifs = await Notification.find({ type: 'APP_UPDATE_AVAILABLE' }).lean();
    expect(notifs).toHaveLength(2);
    const userIds = notifs.map((n) => String(n.userId)).sort();
    expect(userIds).toEqual([String(rider1._id), String(rider2._id)].sort());
    notifs.forEach((n) => {
      expect(n.recipientRole).toBe('user');
      expect(n.title).toBe('New version available');
      expect(n.message).toContain('rider app build (v2.1.0)');
      expect(n.data.version).toBe('2.1.0');
      expect(n.data.downloadUrl).toBe('https://x.test/rider');
      expect(n.priority).toBe('LOW');
    });

    const { __mockSendPushNotificationsAsync } = require('expo-server-sdk');
    expect(__mockSendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    const [sentMessages] = __mockSendPushNotificationsAsync.mock.calls[0];
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].to).toBe('ExponentPushToken[valid1]');
  });

  it('notifies every Driver account for app: "driver" with recipientRole "driver"', async () => {
    const driver1 = await Driver.create({
      name: 'Driver One', email: `rel-d1-${Date.now()}@t.com`, password: 'P@ssw0rd!',
      pushTokens: ['ExponentPushToken[driverTok]']
    });

    const result = await notifyAppUpdateAvailable({ app: 'driver', version: '1.5.0', downloadUrl: 'https://x.test/driver' });

    expect(result.notified).toBe(1);
    const notif = await Notification.findOne({ type: 'APP_UPDATE_AVAILABLE', userId: driver1._id });
    expect(notif).not.toBeNull();
    expect(notif.recipientRole).toBe('driver');
    expect(notif.message).toContain('driver app build (v1.5.0)');

    const { __mockSendPushNotificationsAsync } = require('expo-server-sdk');
    expect(__mockSendPushNotificationsAsync).toHaveBeenCalledTimes(1);
  });

  it('skips push delivery but still returns cleanly when nobody has a valid token', async () => {
    const identity = await Identity.create({ email: `rel-r3-${Date.now()}@t.com`, password: 'P@ssw0rd!' });
    await User.create({
      name: 'Rider Three', identityId: identity._id, email: identity.email, profileKind: 'PRIMARY', pushTokens: []
    });

    const result = await notifyAppUpdateAvailable({ app: 'rider', version: '1.0.0', downloadUrl: 'https://x.test' });

    expect(result.notified).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe('NO_TOKENS');
  });

  it('returns zeroed result when there are no accounts for the app', async () => {
    const result = await notifyAppUpdateAvailable({ app: 'driver', version: '1.0.0', downloadUrl: 'https://x.test' });
    expect(result).toEqual({ notified: 0, sent: 0 });
  });
});
