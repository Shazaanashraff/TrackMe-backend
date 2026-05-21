const express = require('express');
const router = express.Router();
const {
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  getUnreadCount,
  getNotificationById,
  cleanupOldNotifications
} = require('../controllers/notificationController');
const { protect } = require('../middleware/auth');

// All notification routes require authentication
router.use(protect);

// GET /api/notifications - Get user's notifications
router.get('/', getUserNotifications);

// GET /api/notifications/count/unread - Get unread count
router.get('/count/unread', getUnreadCount);

// GET /api/notifications/:notificationId - Get single notification
router.get('/:notificationId', getNotificationById);

// PUT /api/notifications/:notificationId/read - Mark as read
router.put('/:notificationId/read', markAsRead);

// PUT /api/notifications/read-all - Mark all as read
router.put('/read-all', markAllAsRead);

// DELETE /api/notifications/:notificationId - Delete notification
router.delete('/:notificationId', deleteNotification);

// DELETE /api/notifications/admin/cleanup - Clean old notifications (admin only)
router.delete('/admin/cleanup', cleanupOldNotifications);

module.exports = router;
