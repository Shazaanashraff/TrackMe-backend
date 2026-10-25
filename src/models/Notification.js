const mongoose = require('mongoose');
const { notificationCreated } = require('../utils/notificationEvents');

const notificationSchema = new mongoose.Schema({
  eventId: { type: String, unique: true, sparse: true },
  // 'manager' rows are read by web-admin's notification bell; `userId` then
  // holds the Manager id (the ref below is nominal, nothing populates it).
  recipientRole: { type: String, enum: ['user', 'driver', 'manager'], default: 'user' },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'User ID is required']
  },
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RiderProfile',
    default: null,
    index: true
  },
  type: {
    type: String,
    enum: [
      'VEHICLE_ARRIVAL', 'VEHICLE_DEPARTURE', 'ROUTE_UPDATE', 'SYSTEM_ALERT', 'BOOKING_CONFIRMATION', 'PAYMENT_SUCCESS',
      'ROUTE_ACCESS_REQUEST', 'ROUTE_ACCESS_APPROVED', 'ROUTE_ACCESS_REJECTED', 'ROUTE_ACCESS_REVOKED',
      'ENROLLMENT_APPROVED', 'ENROLLMENT_REJECTED', 'BOARDING_EVENT', 'COMMUNICATION',
      'APP_UPDATE_AVAILABLE',
      'RIDER_ACCOUNT_DELETED', 'RIDER_ACCOUNT_RESTORED'
    ],
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
    vehicleId: String,
    routeId: String,
    bookingId: String,
    relatedId: String,
    studentId: String,
    riderId: String,
    conversationId: String,
    absenceId: String,
    revision: Number,
    eventId: String,
    type: { type: String },
    version: String,
    downloadUrl: String
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
notificationSchema.index({ userId: 1, studentId: 1, createdAt: -1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index

// Every create()/save() announces the new row over the socket. Reads go
// through findOneAndUpdate/updateMany and never come this way. `isNew` is
// already false by post('save'), hence the pre() stash.
notificationSchema.pre('save', function stashIsNew(next) {
  this.$locals.wasNew = this.isNew;
  next();
});
notificationSchema.post('save', function announce(doc) {
  if (doc.$locals.wasNew) notificationCreated(doc);
});

module.exports = mongoose.model('Notification', notificationSchema);
