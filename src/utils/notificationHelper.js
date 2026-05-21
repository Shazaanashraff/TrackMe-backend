// Utility functions for notifications

const Notification = require('../models/Notification');

/**
 * Create a notification for a user
 */
exports.createNotification = async (userId, type, title, message, data = {}) => {
  try {
    const notification = await Notification.create({
      userId,
      type,
      title,
      message,
      data: {
        ...data,
        createdAt: new Date()
      },
      priority: data.priority || 'MEDIUM'
    });
    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    return null;
  }
};

/**
 * Create notification for bus arrival
 */
exports.notifyBusArrival = async (userId, bus, route) => {
  return exports.createNotification(
    userId,
    'BUS_ARRIVAL',
    `${bus.busName} Arriving`,
    `Your bus to ${route.destination} is arriving soon. ETA: ${route.estimatedTime} minutes`,
    {
      busId: bus._id,
      routeId: route._id,
      priority: 'HIGH'
    }
  );
};

/**
 * Create notification for bus departure
 */
exports.notifyBusDeparture = async (userId, bus, route) => {
  return exports.createNotification(
    userId,
    'BUS_DEPARTURE',
    `${bus.busName} Departed`,
    `Your bus to ${route.destination} has departed. Safe journey!`,
    {
      busId: bus._id,
      routeId: route._id,
      priority: 'MEDIUM'
    }
  );
};

/**
 * Create notification for route updates
 */
exports.notifyRouteUpdate = async (userId, route) => {
  return exports.createNotification(
    userId,
    'ROUTE_UPDATE',
    `Route Updated: ${route.routeName}`,
    `Route ${route.routeName} has been updated. Please check for changes.`,
    {
      routeId: route._id,
      priority: 'MEDIUM'
    }
  );
};

/**
 * Create notification for system alerts
 */
exports.notifySystemAlert = async (userId, title, message) => {
  return exports.createNotification(
    userId,
    'SYSTEM_ALERT',
    title,
    message,
    {
      priority: 'HIGH'
    }
  );
};

/**
 * Batch create notifications for multiple users
 */
exports.batchCreateNotifications = async (userIds, type, title, message, data = {}) => {
  try {
    const notifications = userIds.map(userId => ({
      userId,
      type,
      title,
      message,
      data,
      priority: data.priority || 'MEDIUM'
    }));

    const result = await Notification.insertMany(notifications);
    return result;
  } catch (error) {
    console.error('Error batch creating notifications:', error);
    return [];
  }
};

/**
 * Get recent notifications for a user
 */
exports.getUserRecentNotifications = async (userId, limit = 5) => {
  try {
    const notifications = await Notification.find({ userId })
      .sort({ createdAt: -1 })
      .limit(limit);
    return notifications;
  } catch (error) {
    console.error('Error fetching notifications:', error);
    return [];
  }
};

/**
 * Clear read notifications older than specific days
 */
exports.clearOldReadNotifications = async (days = 30) => {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const result = await Notification.deleteMany({
      isRead: true,
      readAt: { $lt: cutoffDate }
    });

    return result.deletedCount;
  } catch (error) {
    console.error('Error clearing old notifications:', error);
    return 0;
  }
};
