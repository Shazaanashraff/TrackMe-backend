const Notification = require('../models/Notification');
const User = require('../models/User');
const RiderProfile = require('../models/RiderProfile');

async function riderFilterForRequest(req) {
  const requested = String(req.query?.riderId || req.query?.studentId || '').trim();
  if (!requested || requested === 'all') return {};
  const owned = await RiderProfile.exists({ _id: requested, accountId: req.user._id, isActive: { $ne: false } });
  if (!owned) return null;
  return { $or: [{ studentId: requested }, { studentId: null }] };
}

// @desc    Get user's notifications
// @route   GET /api/notifications
exports.getUserNotifications = async (req, res, next) => {
  try {
    const { page = 1, limit = 10, unreadOnly = false } = req.query;
    const skip = (page - 1) * limit;

    const filter = { userId: req.user._id };
    const riderFilter = await riderFilterForRequest(req);
    if (riderFilter === null) return res.status(404).json({ success: false, message: 'Rider not found' });
    Object.assign(filter, riderFilter);
    if (unreadOnly === 'true') {
      filter.isRead = false;
    }

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Notification.countDocuments(filter);

    res.status(200).json({
      success: true,
      data: notifications,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Mark notification as read
// @route   PUT /api/notifications/:notificationId/read
exports.markAsRead = async (req, res, next) => {
  try {
    const { notificationId } = req.params;

    const notification = await Notification.findOneAndUpdate(
      { _id: notificationId, userId: req.user._id },
      { isRead: true, readAt: new Date() },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Notification marked as read',
      data: notification
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Mark all notifications as read
// @route   PUT /api/notifications/read-all
exports.markAllAsRead = async (req, res, next) => {
  try {
    const riderFilter = await riderFilterForRequest(req);
    if (riderFilter === null) return res.status(404).json({ success: false, message: 'Rider not found' });
    await Notification.updateMany(
      { userId: req.user._id, isRead: false, ...riderFilter },
      { isRead: true, readAt: new Date() }
    );

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a notification
// @route   DELETE /api/notifications/:notificationId
exports.deleteNotification = async (req, res, next) => {
  try {
    const { notificationId } = req.params;

    const notification = await Notification.findOneAndDelete({
      _id: notificationId,
      userId: req.user._id
    });

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Notification deleted'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get unread notifications count
// @route   GET /api/notifications/count/unread
exports.getUnreadCount = async (req, res, next) => {
  try {
    const riderFilter = await riderFilterForRequest(req);
    if (riderFilter === null) return res.status(404).json({ success: false, message: 'Rider not found' });
    const count = await Notification.countDocuments({
      userId: req.user._id,
      isRead: false,
      ...riderFilter
    });

    res.status(200).json({
      success: true,
      unreadCount: count
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create notification (internal use)
// Internal helper function - not exposed as route
exports.createNotification = async (userId, type, title, message, data = {}) => {
  try {
    const notification = await Notification.create({
      userId,
      type,
      title,
      message,
      data,
      priority: 'MEDIUM'
    });
    return notification;
  } catch (error) {
    console.error('Error creating notification:', error);
    return null;
  }
};

// @desc    Get notification by ID
// @route   GET /api/notifications/:notificationId
exports.getNotificationById = async (req, res, next) => {
  try {
    const { notificationId } = req.params;

    const notification = await Notification.findOne({
      _id: notificationId,
      userId: req.user._id
    });

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    res.status(200).json({
      success: true,
      data: notification
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Register (or refresh) this device's Expo push token for the caller
// @route   POST /api/notifications/device-token
// Used by QR Attendance push delivery (see
// docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md) and available to any push feature.
exports.registerDeviceToken = async (req, res, next) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      return res.status(400).json({ success: false, message: 'token is required' });
    }

    // Push tokens are a rider-only feature (see User.js pushTokens comment); other
    // account types don't have this field, so there's nothing to store for them.
    if (req.user.role === 'user') {
      await User.findByIdAndUpdate(req.user._id, { $addToSet: { pushTokens: token } });
    }

    return res.status(200).json({ success: true, message: 'Device token registered' });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete all old notifications (admin only)
// @route   DELETE /api/notifications/admin/cleanup
exports.cleanupOldNotifications = async (req, res, next) => {
  try {
    const result = await Notification.deleteMany({
      expiresAt: { $lt: new Date() }
    });

    res.status(200).json({
      success: true,
      message: 'Old notifications cleaned up',
      deletedCount: result.deletedCount
    });
  } catch (error) {
    next(error);
  }
};
