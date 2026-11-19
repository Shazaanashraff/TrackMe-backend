// Expo push delivery for QR boarding/alighting events.
// See docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md "Push notifications".
const { Expo } = require('expo-server-sdk');
const User = require('../models/User');
const { removeToken } = require('../services/communicationPush');

const expo = new Expo();

// Android channels the passenger app creates at startup (notificationHandler.ts,
// communications/provider.js). Both show on the lock screen. A channelId the app
// has not created falls back to a generic channel with no heads-up popup.
const CHANNELS = { BUS_UPDATES: 'bus-updates', ACCOUNT: 'account', COMMUNICATIONS: 'communications' };

// Send Expo messages in chunks, then deal with what the tickets say: a token the
// device no longer honours is pruned, and a credentials error (Firebase/APNs not
// set up on the Expo project) is logged, since otherwise a push that never
// arrives looks like success. Returns the tickets; the caller handles throws.
async function sendMessages(messages) {
  const tickets = [];
  for (const chunk of expo.chunkPushNotifications(messages)) {
    // eslint-disable-next-line no-await-in-loop
    const chunkTickets = await expo.sendPushNotificationsAsync(chunk);
    for (let i = 0; i < chunkTickets.length; i++) {
      const ticket = chunkTickets[i];
      if (ticket.status !== 'error') continue;
      const code = ticket.details && ticket.details.error;
      if (code === 'DeviceNotRegistered') {
        // eslint-disable-next-line no-await-in-loop
        await removeToken(chunk[i].to).catch(() => {});
      } else {
        console.error(`Expo push ticket error${code ? ` (${code})` : ''}: ${ticket.message || ''}`);
      }
    }
    tickets.push(...chunkTickets);
  }
  return tickets;
}

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
      channelId: CHANNELS.ACCOUNT,
      priority: 'high',
      ttl: 60 * 60, // a boarding notice is worthless after an hour
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

    const tickets = await sendMessages(messages);
    return { sent: tickets.length, tickets };
  } catch (error) {
    console.error('Error sending Expo push for boarding event:', error.message);
    return { sent: 0, error: error.message };
  }
}

// "<Driver> has arrived at <stop>" push for the parent of a rider whose stop the shuttle
// has pulled up to. Same delivery rules as the boarding push: household tokens, never
// throws, returns a small summary.
async function sendArrivalPush(student, account, { vehicleName, stopName, routeId, vehicleId }) {
  try {
    const tokens = await resolvePushTokensForRider(account || student);
    if (tokens.length === 0) return { sent: 0, skipped: 'NO_TOKENS' };

    const who = student.fullName || student.name || 'your rider';
    const messages = tokens.map((to) => ({
      to,
      sound: 'default',
      channelId: CHANNELS.BUS_UPDATES,
      priority: 'high',
      ttl: 10 * 60, // "has arrived" is stale after ten minutes
      title: `${vehicleName || 'Your shuttle'} has arrived`,
      body: `Waiting at ${stopName || 'the stop'} for ${who}.`,
      data: {
        type: 'VEHICLE_ARRIVAL',
        studentId: String(student._id),
        routeId,
        vehicleId
      }
    }));

    const tickets = await sendMessages(messages);
    return { sent: tickets.length, tickets };
  } catch (error) {
    console.error('Error sending Expo push for arrival:', error.message);
    return { sent: 0, error: error.message };
  }
}

module.exports = { sendBoardingPush, sendArrivalPush, resolvePushTokensForRider, sendMessages, CHANNELS };
