const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required']
  },
  type: {
    type: String,
    enum: ['BUS_ARRIVAL', 'BUS_DEPARTURE', 'ROUTE_UPDATE', 'SYSTEM_ALERT', 'BOOKING_CONFIRMATION', 'PAYMENT_SUCCESS'],
    required: [true, 'Notification type is required']
  },
  title: {
    type: String,
    required: [true, 'Notification title is required']
  },
  message: {
    type: String,
    required: [true, 'Notification message is required']
  },
  data: {
    busId: String,
    routeId: String,
    bookingId: String,
    relatedId: String
  },
  isRead: {
    type: Boolean,
    default: false
  },
  readAt: Date,
  priority: {
    type: String,
    enum: ['LOW', 'MEDIUM', 'HIGH'],
    default: 'MEDIUM'
  },
  expiresAt: {
    type: Date,
    default: () => new Date(+new Date() + 30 * 24 * 60 * 60 * 1000) // 30 days from now
  }
}, {
  timestamps: true
});

// Index for faster queries
notificationSchema.index({ userId: 1, isRead: 1 });
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index

module.exports = mongoose.model('Notification', notificationSchema);
