const mongoose = require('mongoose');

// QR Attendance — see docs/features/qr-attendance/QR_SYSTEM.md.
// One row per driver-scanned BOARD or ALIGHT event. `studentId` is the rider's own
// User account (the QR pass is account-scoped, not tied to any route membership).
const BOARDING_EVENT_TYPES = ['BOARD', 'ALIGHT'];
const BOARDING_EVENT_SOURCES = ['QR'];

const boardingEventSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  busId: {
    type: String,
    required: true,
    trim: true
  },
  routeId: {
    type: String,
    required: true,
    trim: true,
    uppercase: true
  },
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: BOARDING_EVENT_TYPES,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  lat: {
    type: Number,
    default: null
  },
  lng: {
    type: Number,
    default: null
  },
  // No formal "trip" entity exists yet. Defaults to a per-bus, per-calendar-day
  // window (`${busId}#YYYY-MM-DD`) so BOARD/ALIGHT toggling has a stable scope;
  // callers may pass an explicit tripId to override once a real trip concept lands.
  tripId: {
    type: String,
    default: null
  },
  source: {
    type: String,
    enum: BOARDING_EVENT_SOURCES,
    default: 'QR'
  }
}, {
  timestamps: true
});

boardingEventSchema.index({ studentId: 1, timestamp: -1 });
boardingEventSchema.index({ routeId: 1, timestamp: -1 });
// Debounce lookups: most-recent event for a given student on a given bus/type.
boardingEventSchema.index({ studentId: 1, busId: 1, type: 1, timestamp: -1 });
// Toggle resolution: most-recent event for a student within a trip.
boardingEventSchema.index({ studentId: 1, tripId: 1, timestamp: -1 });

boardingEventSchema.statics.TYPES = BOARDING_EVENT_TYPES;

module.exports = mongoose.model('BoardingEvent', boardingEventSchema);
