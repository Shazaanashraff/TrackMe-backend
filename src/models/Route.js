const mongoose = require('mongoose');

const SERVICE_TYPES = ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'];
const VISIBILITY_TYPES = ['PUBLIC', 'PRIVATE'];
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
  // Approximate size of the real-world fleet operating this route (both directions
  // combined). Drives the client-side deterministic bus simulation on the live map
  // (see UserApp useSimulatedBuses). 0 = no simulation for this route. Set for the
  // curated demo routes by scripts/set-sim-bus-counts.js.
  simBusCount: {
    type: Number,
    default: 0,
    min: [0, 'Simulated bus count cannot be negative']
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
    ref: 'User'
  },
  // Custom-route (school/work shuttle) fields. A PRIVATE route is owned by a single
  // manager, reusable only for their own drivers, and must never surface in any
  // user-app/public-facing query (see routeController.js / socketHandler.js filters).
  visibility: {
    type: String,
    enum: VISIBILITY_TYPES,
    default: 'PUBLIC'
  },
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
    recordedByDriverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    recordedByBusId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bus', default: null },
    recordedAt: { type: Date, default: null },
    rawPointCount: { type: Number, default: 0 },
    snapped: { type: Boolean, default: false }
  },
  // Privacy / room-key (Private Routes feature). visibility:'PRIVATE' => requires a room key to join.
  isHidden: { type: Boolean, default: false }, // PRIVATE + not listed anywhere in user-app
  joinApprovalRequired: { type: Boolean, default: false }, // PRIVATE + correct PIN also needs manager approval
  roomKey: {
    ciphertext: { type: String, default: null }, // AES-256-GCM of the 6-digit code (base64)
    iv: { type: String, default: null },
    authTag: { type: String, default: null },
    // No default: must stay entirely absent (not null) so the sparse unique index
    // below only ever applies to routes that actually have a key.
    lookupHash: { type: String },
    updatedAt: { type: Date, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  }
}, {
  timestamps: true
});

// PUBLIC routes must never carry privacy flags/room-key. Clears them whenever
// visibility flips back to PUBLIC (see PRIVATE_ROUTES_PLAN.md §3.1).
routeSchema.pre('save', function clearPrivacyOnPublic(next) {
  if (this.visibility === 'PUBLIC' && this.isModified('visibility')) {
    this.isHidden = false;
    this.joinApprovalRequired = false;
    this.roomKey = { ciphertext: null, iv: null, authTag: null, lookupHash: undefined, updatedAt: null, updatedBy: null };
  }
  next();
});

// Index for faster queries
// Note: routeId already has a unique index from `unique: true` on the field.
routeSchema.index({ isActive: 1, isDeleted: 1 });
routeSchema.index({ serviceType: 1, isActive: 1, isDeleted: 1 });
routeSchema.index({ managerId: 1, visibility: 1, status: 1, isDeleted: 1 });
routeSchema.index({ province: 1 });
routeSchema.index({ 'roomKey.lookupHash': 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Route', routeSchema);
