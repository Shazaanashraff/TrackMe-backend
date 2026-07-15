const { sendBoardingPush } = require('../../src/utils/pushHelper');

// pushHelper.js loads expo-server-sdk via a dynamic import() because the
// package ships ESM-only (a static require() throws ERR_REQUIRE_ESM). This
// test locks in that the dynamic import still resolves through Jest's mock
// registry and that sendBoardingPush's behavior is unchanged. No DB needed.

jest.mock('expo-server-sdk', () => {
  const sendPushNotificationsAsync = jest.fn().mockResolvedValue([{ status: 'ok', id: 'ticket-1' }]);
  function Expo() {
    return { chunkPushNotifications: (messages) => [messages], sendPushNotificationsAsync };
  }
  Expo.isExpoPushToken = (t) => typeof t === 'string' && t.startsWith('ExponentPushToken');
  return { Expo, __mockSendPushNotificationsAsync: sendPushNotificationsAsync };
});

describe('pushHelper.sendBoardingPush', () => {
  it('skips delivery when the user has no Expo push tokens', async () => {
    const result = await sendBoardingPush({ pushTokens: [] }, { type: 'BOARD', timestamp: Date.now(), _id: 'e1' }, 'Bus 1');
    expect(result).toEqual({ sent: 0, skipped: 'NO_TOKENS' });
  });

  it('filters out non-Expo tokens and sends only to valid ones', async () => {
    const { __mockSendPushNotificationsAsync } = require('expo-server-sdk');
    __mockSendPushNotificationsAsync.mockClear();

    const user = { name: 'Rider', pushTokens: ['not-a-token', 'ExponentPushToken[abc123]'] };
    const event = { type: 'BOARD', timestamp: Date.now(), _id: 'e2', routeId: 'r1', busId: 'b1' };

    const result = await sendBoardingPush(user, event, 'Bus 1');

    expect(__mockSendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    const [sentMessages] = __mockSendPushNotificationsAsync.mock.calls[0];
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].to).toBe('ExponentPushToken[abc123]');
    expect(result.sent).toBe(1);
  });

  it('never throws — returns an error summary if the SDK call rejects', async () => {
    const { __mockSendPushNotificationsAsync } = require('expo-server-sdk');
    __mockSendPushNotificationsAsync.mockRejectedValueOnce(new Error('network down'));

    const user = { name: 'Rider', pushTokens: ['ExponentPushToken[abc123]'] };
    const event = { type: 'ALIGHT', timestamp: Date.now(), _id: 'e3', routeId: 'r1', busId: 'b1' };

    const result = await sendBoardingPush(user, event, 'Bus 1');
    expect(result).toEqual({ sent: 0, error: 'network down' });
  });
});
