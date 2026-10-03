// Utility functions for notifications

const { Expo } = require('expo-server-sdk');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Driver = require('../models/Driver');

const expo = new Expo();

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
 * Create notification for vehicle arrival
 */
exports.notifyVehicleArrival = async (userId, vehicle, route) => {
  return exports.createNotification(
    userId,
    'VEHICLE_ARRIVAL',
    `${vehicle.vehicleName} Arriving`,
    `Your vehicle to ${route.destination} is arriving soon. ETA: ${route.estimatedTime} minutes`,
    {
      vehicleId: vehicle._id,
      routeId: route._id,
      priority: 'HIGH'
    }
  );
};

/**
 * Create notification for vehicle departure
 */
exports.notifyVehicleDeparture = async (userId, vehicle, route) => {
  return exports.createNotification(
    userId,
    'VEHICLE_DEPARTURE',
    `${vehicle.vehicleName} Departed`,
    `Your vehicle to ${route.destination} has departed. Safe journey!`,
    {
      vehicleId: vehicle._id,
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
exports.batchCreateNotifications = async (userIds, type, title, message, data = {}, recipientRole = 'user') => {
  try {
    const notifications = userIds.map(userId => ({
      userId,
      recipientRole,
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
 * Notify every account of the given app ('driver' or 'rider') that a new
 * build is available. Used for iOS releases only — iOS has no in-app update
 * check, so this notification + push is the sole way those users learn a new
 * build exists (Android gets the in-app automatic-update flow instead).
 *
 * Fires for every account regardless of which platform the account actually
 * runs — there is no platform field on stored push tokens today, so an
 * Android user with no iOS device also gets this. Harmless: they already have
 * the in-app update flow, so the push is simply redundant for them.
 */
exports.notifyAppUpdateAvailable = async ({ app, version, downloadUrl }) => {
  const Model = app === 'driver' ? Driver : User;
  const recipientRole = app === 'driver' ? 'driver' : 'user';

  const accounts = await Model.find({}).select('_id pushTokens').lean();
  if (accounts.length === 0) {
    return { notified: 0, sent: 0 };
  }

  const title = 'New version available';
  const message = `A new TrackMe ${app} app build (v${version}) is available. Visit the website to download it.`;
  const data = { version, downloadUrl, priority: 'LOW' };

  const userIds = accounts.map((account) => account._id);
  await exports.batchCreateNotifications(userIds, 'APP_UPDATE_AVAILABLE', title, message, data, recipientRole);

  try {
    const tokens = [...new Set(accounts.flatMap((account) => (Array.isArray(account.pushTokens) ? account.pushTokens : [])))]
      .filter((token) => Expo.isExpoPushToken(token));

    if (tokens.length === 0) {
      return { notified: userIds.length, sent: 0, skipped: 'NO_TOKENS' };
    }

    const messages = tokens.map((to) => ({
      to,
      sound: 'default',
      title,
      body: message,
      data: { type: 'APP_UPDATE_AVAILABLE', version, downloadUrl }
    }));

    const chunks = expo.chunkPushNotifications(messages);
    const tickets = [];
    for (const chunk of chunks) {
      // eslint-disable-next-line no-await-in-loop
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...ticketChunk);
    }
    return { notified: userIds.length, sent: tickets.length, tickets };
  } catch (error) {
    console.error('Error sending Expo push for app update notification:', error.message);
    return { notified: userIds.length, sent: 0, error: error.message };
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
