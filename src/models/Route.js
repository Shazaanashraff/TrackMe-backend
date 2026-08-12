const mongoose = require('mongoose');

const SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];
const ORIGIN_TYPES = ['SYSTEM', 'RECORDED'];
const ROUTE_STATUSES = ['ACTIVE', 'PENDING_NAMING'];

const routeSchema = new mongoose.Schema({
  routeId: {
    type: String,
    required: [true, 'Route ID is required'],
    unique: true,
    trim: true,
    uppercase: true
  },
  routeName: {
    type: String,
    required: [true, 'Route name is required'],
    trim: true
  },
  source: {
    type: String,
    required: [true, 'Source is required'],
    trim: true
  },
  destination: {
    type: String,
    required: [true, 'Destination is required'],
    trim: true
  },
  // Sri Lanka province this route operates in, derived from its stop coordinates
  // (see scripts/assign-provinces-and-managers.js). Used to route ownership to the
  // matching province manager account.
  province: {
    type: String,
    default: ''
  },
  distance: {
    type: Number,
    required: [true, 'Distance is required'],
    min: [0, 'Distance must be greater than 0']
  },
  estimatedTime: {
    type: Number,
    default: 0,
    min: [0, 'Estimated time must be at least 0']
  },
  fare: {
    type: Number,
    required: [true, 'Fare is required'],
    min: [0, 'Fare must be greater than 0']
  },
  serviceType: {
    type: String,
    enum: SERVICE_TYPES,
    default: 'PUBLIC',
    uppercase: true
  },
  stopsCount: {
    type: Number,
    default: 0,
    min: [0, 'Stops count must be at least 0']
  },
  stops: [
    {
      stopName: String,
      order: Number,
      lat: Number,
      lng: Number
    }
  ],
  // Real road geometry for the route, stored as a Google-encoded polyline. Filled
  // by scripts/backfill-route-geometry.js from a matched Google Transit line, so the
  // map draws an accurate, stable line without a live API call. Empty = no accurate
  // geometry available (we never store an invented/guessed line here).
  pathPolyline: {
    type: String,
    default: ''
  },
  // Return-direction geometry (destination -> origin). Many routes take a slightly
  // different road on the way back (one-way sections/loops); drawing both gives the
  // full there-and-back shape. Empty when the return path isn't available/different.
  pathPolylineReturn: {
    type: String,
    default: ''
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Manager'
  },
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Manager',
    default: null
  },
  origin: {
    type: String,
    enum: ORIGIN_TYPES,
    default: 'SYSTEM'
  },
  // PENDING_NAMING = provisional route auto-created for a not-yet-recorded custom
  // driver, or recorded but not yet named by the manager. Hidden everywhere until ACTIVE.
  status: {
    type: String,
    enum: ROUTE_STATUSES,
    default: 'ACTIVE'
  },
  recordedMeta: {
    recordedByDriverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver', default: null },
    recordedByVehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', default: null },
    recordedAt: { type: Date, default: null },
    rawPointCount: { type: Number, default: 0 },
    snapped: { type: Boolean, default: false }
  },
  // QR Attendance (see docs/features/qr-attendance/QR_SYSTEM.md). Manager-owned toggle —
  // when true, a driver's vehicle on this route may record BOARD/ALIGHT scans.
  qrEnabled: { type: Boolean, default: false }
}, {
  timestamps: true
});

// Index for faster queries
// Note: routeId already has a unique index from `unique: true` on the field.
routeSchema.index({ isActive: 1, isDeleted: 1 });
routeSchema.index({ serviceType: 1, isActive: 1, isDeleted: 1 });
routeSchema.index({ managerId: 1, status: 1, isDeleted: 1 });
routeSchema.index({ province: 1 });

module.exports = mongoose.model('Route', routeSchema);
