// Expo push delivery for QR boarding/alighting events.
// See docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md "Push notifications".
const { Expo } = require('expo-server-sdk');

const expo = new Expo();

function formatTime(date) {
  return new Date(date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// Sends a "<Child> boarded/alighted <Bus> at HH:MM" push to every registered Expo
// token on `user`. Never throws — push delivery failures must not block the scan
// endpoint or attendance recording. Returns a small delivery summary for logging/tests.
async function sendBoardingPush(user, event, busName) {
  try {
    const tokens = Array.isArray(user?.pushTokens)
      ? user.pushTokens.filter((t) => Expo.isExpoPushToken(t))
      : [];

    if (tokens.length === 0) {
      return { sent: 0, skipped: 'NO_TOKENS' };
    }

    const verb = event.type === 'BOARD' ? 'boarded' : 'alighted';
    const messages = tokens.map((to) => ({
      to,
      sound: 'default',
      title: `${user.name || 'Rider'} ${verb} ${busName || 'the bus'}`,
      body: `at ${formatTime(event.timestamp)}`,
      data: {
        type: 'BOARDING_EVENT',
        eventId: String(event._id),
        boardingType: event.type,
        routeId: event.routeId,
        busId: event.busId
      }
    }));

    const chunks = expo.chunkPushNotifications(messages);
    const tickets = [];
    for (const chunk of chunks) {
      // eslint-disable-next-line no-await-in-loop
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    }
    return { sent: tickets.length, tickets };
  } catch (error) {
    console.error('Error sending Expo push for boarding event:', error.message);
    return { sent: 0, error: error.message };
  }
}

module.exports = { sendBoardingPush };
