// Tells an open client that a Notification row now exists, so its unread badge
// can move without waiting for a push (which web never gets) or a foreground.
//
// Bound once from server.js; a script or test that never binds gets a no-op.
let io = null;

function bindIo(server) {
  io = server;
}

// Rooms: a rider socket joins `student:<profileId>` for every profile in its
// household (socket/socketHandler.js), and Notification.userId is that profile
// id, so one emit reaches whichever household member is connected. Drivers
// join `driver:<id>`.
function notificationCreated(notification) {
  if (!io || !notification?.userId) return;
  const room = `${notification.recipientRole === 'driver' ? 'driver' : 'student'}:${notification.userId}`;
  io.to(room).emit('notification:new', {
    notificationId: String(notification._id),
    type: notification.type,
    title: notification.title,
    studentId: notification.studentId ? String(notification.studentId) : null,
    createdAt: notification.createdAt
  });
}

module.exports = { bindIo, notificationCreated };
