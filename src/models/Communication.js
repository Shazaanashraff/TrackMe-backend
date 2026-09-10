const mongoose = require('mongoose');
const { Schema } = mongoose;
const ref = (model) => ({ type: Schema.Types.ObjectId, ref: model, required: true });
const conversation = new Schema({
  riderId: ref('RiderProfile'), driverId: ref('Driver'), accountId: ref('User'),
  riderName: String, driverName: String,
  userReadThrough: Schema.Types.ObjectId, driverReadThrough: Schema.Types.ObjectId,
}, { timestamps: true });
conversation.index({ riderId: 1, driverId: 1 }, { unique: true });
conversation.index({ accountId: 1, updatedAt: -1 });
conversation.index({ driverId: 1, updatedAt: -1 });
const message = new Schema({
  conversationId: ref('Conversation'), eventId: { type: String, unique: true, required: true },
  requestHash: String, sender: { type: String, enum: ['user', 'driver', 'system'], required: true },
  text: { type: String, maxlength: 1000, required: true }, templateId: String,
  absenceId: Schema.Types.ObjectId, revision: Number, absenceStatus: String,
  announcementId: Schema.Types.ObjectId, correctionOf: Schema.Types.ObjectId,
  deliveryPending: { type: Boolean, default: true, index: true },
}, { timestamps: true });
message.index({ conversationId: 1, _id: -1 });
const transition = new Schema({
  eventId: String, requestId: String, requestHash: String, revision: Number,
  action: String, text: String, at: Date, pending: { type: Boolean, default: true },
}, { _id: false });
const absence = new Schema({
  riderId: ref('RiderProfile'), driverId: ref('Driver'), accountId: ref('User'),
  enrollmentId: ref('DriverEnrollment'), conversationId: ref('Conversation'),
  date: { type: String, required: true },
  status: { type: String, enum: ['ABSENT', 'CANCELLED', 'RETIRED'], required: true },
  revision: { type: Number, required: true }, acknowledgedRevision: { type: Number, default: 0 },
  history: [transition],
}, { timestamps: true });
absence.index({ riderId: 1, driverId: 1, date: 1 }, { unique: true });
absence.index({ driverId: 1, date: 1, status: 1 });
absence.index({ accountId: 1, date: 1 });
absence.index({ 'history.pending': 1 });
const announcement = new Schema({
  driverId: ref('Driver'), requestId: String, requestHash: String,
  templateId: String, parameters: Schema.Types.Mixed, text: { type: String, maxlength: 1000 },
  date: String, audience: { type: String, enum: ['all', 'selected'] }, correctionOf: Schema.Types.ObjectId,
  recipients: [{
    riderId: ref('RiderProfile'), accountId: ref('User'), enrollmentId: ref('DriverEnrollment'),
    state: { type: String, enum: ['pending', 'sent', 'failed', 'skipped'], default: 'pending' },
    error: String,
  }],
  pushQueued: { type: Boolean, default: false },
}, { timestamps: true });
announcement.index({ driverId: 1, requestId: 1 }, { unique: true });
announcement.index({ 'recipients.state': 1 });
const pushDelivery = new Schema({
  eventId: { type: String, required: true, unique: true }, recipientId: Schema.Types.ObjectId,
  role: String, title: String, body: String, data: Schema.Types.Mixed,
  state: { type: String, default: 'pending' }, attempts: { type: Number, default: 0 },
  nextAttempt: { type: Date, default: Date.now }, leaseUntil: Date,
  devices: [{ token: String, ticketId: String, state: String }], error: String,
}, { timestamps: true });
pushDelivery.index({ state: 1, nextAttempt: 1 });
module.exports = {
  Conversation: mongoose.model('Conversation', conversation),
  Message: mongoose.model('Message', message),
  Absence: mongoose.model('Absence', absence),
  Announcement: mongoose.model('Announcement', announcement),
  PushDelivery: mongoose.model('CommunicationPushDelivery', pushDelivery),
};
