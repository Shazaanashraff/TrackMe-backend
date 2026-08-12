const User = require('../../src/models/User');
const Identity = require('../../src/models/Identity');
const { sendBoardingPush } = require('../../src/utils/pushHelper');
const { connectTestDb, clearTestDb, closeTestDb } = require('./db');

// pushHelper.test.js locks the no-identityId fallback with plain objects and
// no DB. This covers the actual point of the household fix: a boarding push
// for a scanned MANAGED profile (which never carries its own push tokens)
// must still reach the account holder's device.

jest.mock('expo-server-sdk', () => {
  const sendPushNotificationsAsync = jest.fn().mockResolvedValue([{ status: 'ok', id: 'ticket-1' }]);
  function Expo() {
    return { chunkPushNotifications: (messages) => [messages], sendPushNotificationsAsync };
  }
  Expo.isExpoPushToken = (t) => typeof t === 'string' && t.startsWith('ExponentPushToken');
  return { Expo, __mockSendPushNotificationsAsync: sendPushNotificationsAsync };
});

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

const event = { type: 'BOARD', timestamp: Date.now(), _id: 'e1', routeId: 'r1', vehicleId: 'b1' };

describe('sendBoardingPush across a household', () => {
  it("delivers to the parent's device when the scanned rider is a managed child with no tokens of its own", async () => {
    const identity = await Identity.create({ email: `hh-${Date.now()}@t.com`, password: 'P@ssw0rd!' });
    await User.create({
      name: 'Parent', identityId: identity._id, email: identity.email, profileKind: 'PRIMARY',
      pushTokens: ['ExponentPushToken[parent-device]']
    });
    const child = await User.create({
      name: 'Child', identityId: identity._id, profileKind: 'MANAGED', pushTokens: []
    });

    const result = await sendBoardingPush(child, event, 'Shuttle 1');

    const { __mockSendPushNotificationsAsync } = require('expo-server-sdk');
    expect(result.sent).toBe(1);
    const [sentMessages] = __mockSendPushNotificationsAsync.mock.calls[0];
    expect(sentMessages[0].to).toBe('ExponentPushToken[parent-device]');
    // The push announces the child by name, not "Parent" — see boardingController.
    expect(sentMessages[0].title).toContain('Child');
  });

  it('unions tokens from every profile on the identity, de-duplicated', async () => {
    const identity = await Identity.create({ email: `hh2-${Date.now()}@t.com`, password: 'P@ssw0rd!' });
    const parent = await User.create({
      name: 'Parent', identityId: identity._id, email: identity.email, profileKind: 'PRIMARY',
      pushTokens: ['ExponentPushToken[device-a]', 'ExponentPushToken[device-b]']
    });
    await User.create({
      name: 'Child', identityId: identity._id, profileKind: 'MANAGED',
      pushTokens: ['ExponentPushToken[device-a]'] // duplicate of the parent's — should collapse
    });

    await sendBoardingPush(parent, event, 'Shuttle 1');

    const { __mockSendPushNotificationsAsync } = require('expo-server-sdk');
    const [sentMessages] = __mockSendPushNotificationsAsync.mock.calls[0];
    // The mock returns one fixed ticket per call regardless of chunk size
    // (see push-helper.test.js), so the de-dupe assertion is on the messages
    // actually built, not on result.sent.
    expect(sentMessages.map((m) => m.to).sort()).toEqual([
      'ExponentPushToken[device-a]', 'ExponentPushToken[device-b]'
    ]);
  });

  it('skips delivery when nobody in the household has a device registered', async () => {
    const identity = await Identity.create({ email: `hh3-${Date.now()}@t.com`, password: 'P@ssw0rd!' });
    await User.create({ name: 'Parent', identityId: identity._id, email: identity.email, profileKind: 'PRIMARY' });
    const child = await User.create({ name: 'Child', identityId: identity._id, profileKind: 'MANAGED' });

    const result = await sendBoardingPush(child, event, 'Shuttle 1');
    expect(result).toEqual({ sent: 0, skipped: 'NO_TOKENS' });
  });
});
