// Expo push delivery for QR boarding/alighting events.
// See docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md "Push notifications".
const { Expo } = require('expo-server-sdk');
const User = require('../models/User');

const expo = new Expo();

function formatTime(date) {
  return new Date(date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// A managed rider profile (a child, an employee someone else set up) has no
// device of its own — push tokens are only ever registered on the account
// holder (see notificationController.registerDeviceToken). Without this, a
// boarding push for a scanned child resolves zero tokens and the parent is
// silently never told their child boarded, which defeats most of the point
// of the feature. Falls back to the rider's own tokens when it has no
// identityId (a pre-migration document, in principle), so this stays correct
// for every account shape, not just multi-profile ones.
async function resolvePushTokensForRider(rider) {
  if (!rider) return [];

  if (!rider.identityId) {
    return Array.isArray(rider.pushTokens) ? rider.pushTokens.filter((t) => Expo.isExpoPushToken(t)) : [];
  }

  const household = await User.find({ identityId: rider.identityId }).select('pushTokens').lean();
  const tokens = household.flatMap((doc) => (Array.isArray(doc.pushTokens) ? doc.pushTokens : []));
  return [...new Set(tokens)].filter((t) => Expo.isExpoPushToken(t));
}

// Sends a "<Child> boarded/alighted <Vehicle> at HH:MM" push to every Expo token
// registered anywhere in the household. Never throws — push delivery failures
// must not block the scan endpoint or attendance recording. Returns a small delivery
// summary for logging/tests.
//
// `student` is the rider profile that was scanned (it names the push); `account`
// is the account holder that actually owns the device tokens. They are separate
// because a managed profile has no device of its own. `account` falls back to
// `student` so a self-owned rider — which is its own account — still resolves.
async function sendBoardingPush(student, account, event, vehicleName) {
  try {
    const tokens = await resolvePushTokensForRider(account || student);

    if (tokens.length === 0) {
      return { sent: 0, skipped: 'NO_TOKENS' };
    }

    const verb = event.type === 'BOARD' ? 'boarded' : 'alighted';
    const messages = tokens.map((to) => ({
      to,
      sound: 'default',
      title: `${student.fullName || student.name || 'Rider'} ${verb} ${vehicleName || 'the vehicle'}`,
      body: `at ${formatTime(event.timestamp)}`,
      data: {
        type: 'BOARDING_EVENT',
        studentId: String(student._id),
        eventId: String(event._id),
        boardingType: event.type,
        routeId: event.routeId,
        vehicleId: event.vehicleId
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

module.exports = { sendBoardingPush, resolvePushTokensForRider };
