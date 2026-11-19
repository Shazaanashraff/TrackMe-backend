const { sendBoardingPush, sendArrivalPush } = require('../../src/utils/pushHelper');

jest.mock('../../src/services/communicationPush', () => ({ removeToken: jest.fn().mockResolvedValue() }));

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
    const result = await sendBoardingPush({ pushTokens: [] }, null, { type: 'BOARD', timestamp: Date.now(), _id: 'e1' }, 'Vehicle 1');
    expect(result).toEqual({ sent: 0, skipped: 'NO_TOKENS' });
  });

  it('filters out non-Expo tokens and sends only to valid ones', async () => {
    const { __mockSendPushNotificationsAsync } = require('expo-server-sdk');
    __mockSendPushNotificationsAsync.mockClear();

    const user = { name: 'Rider', pushTokens: ['not-a-token', 'ExponentPushToken[abc123]'] };
    const event = { type: 'BOARD', timestamp: Date.now(), _id: 'e2', routeId: 'r1', vehicleId: 'b1' };

    const result = await sendBoardingPush(user, user, event, 'Vehicle 1');

    expect(__mockSendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    const [sentMessages] = __mockSendPushNotificationsAsync.mock.calls[0];
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].to).toBe('ExponentPushToken[abc123]');
    // A channel the passenger app creates at startup, delivered at high priority.
    expect(sentMessages[0].channelId).toBe('account');
    expect(sentMessages[0].priority).toBe('high');
    expect(sentMessages[0].ttl).toBe(3600);
    expect(result.sent).toBe(1);
  });

  it('never throws — returns an error summary if the SDK call rejects', async () => {
    const { __mockSendPushNotificationsAsync } = require('expo-server-sdk');
    __mockSendPushNotificationsAsync.mockRejectedValueOnce(new Error('network down'));

    const user = { name: 'Rider', pushTokens: ['ExponentPushToken[abc123]'] };
    const event = { type: 'ALIGHT', timestamp: Date.now(), _id: 'e3', routeId: 'r1', vehicleId: 'b1' };

    const result = await sendBoardingPush(user, user, event, 'Vehicle 1');
    expect(result).toEqual({ sent: 0, error: 'network down' });
  });

  it('sends arrival pushes on the bus-updates channel, high priority, expiring in ten minutes', async () => {
    const { __mockSendPushNotificationsAsync } = require('expo-server-sdk');
    __mockSendPushNotificationsAsync.mockClear();
    const rider = { name: 'Amaya', _id: 's1', pushTokens: ['ExponentPushToken[abc123]'] };

    await sendArrivalPush(rider, rider, { vehicleName: 'Van 1', stopName: 'Gate', routeId: 'r1', vehicleId: 'v1' });

    const [sent] = __mockSendPushNotificationsAsync.mock.calls[0];
    expect(sent[0]).toMatchObject({ channelId: 'bus-updates', priority: 'high', ttl: 600 });
    expect(sent[0].data).toMatchObject({ type: 'VEHICLE_ARRIVAL', routeId: 'r1' });
  });

  it('prunes a token Expo says is no longer registered', async () => {
    const { __mockSendPushNotificationsAsync } = require('expo-server-sdk');
    const { removeToken } = require('../../src/services/communicationPush');
    removeToken.mockClear();
    __mockSendPushNotificationsAsync.mockResolvedValueOnce([
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ]);
    const rider = { name: 'Amaya', _id: 's1', pushTokens: ['ExponentPushToken[dead]'] };

    await sendArrivalPush(rider, rider, { routeId: 'r1' });

    expect(removeToken).toHaveBeenCalledWith('ExponentPushToken[dead]');
  });

  it('logs a credentials error instead of hiding it', async () => {
    const { __mockSendPushNotificationsAsync } = require('expo-server-sdk');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    __mockSendPushNotificationsAsync.mockResolvedValueOnce([
      { status: 'error', message: 'Unable to retrieve the FCM server key', details: { error: 'InvalidCredentials' } },
    ]);
    const rider = { name: 'Amaya', _id: 's1', pushTokens: ['ExponentPushToken[abc123]'] };

    await sendArrivalPush(rider, rider, { routeId: 'r1' });

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('InvalidCredentials'));
    spy.mockRestore();
  });
});
