const mongoose = require('mongoose');

// Phase 2: end-of-journey off-route detection. When a driver's breadcrumb deviates
// from their assigned custom route beyond threshold, a candidate re-recorded route
// is snapped and offered to the manager to keep the old route or adopt the new one.
const routeChangeRequestSchema = new mongoose.Schema({
  busId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bus',
    required: true,
    index: true
  },
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Manager',
    required: true,
    index: true
  },
  currentRouteId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Route',
    required: true
  },
  candidate: {
    pathPolyline: { type: String, default: '' },
    stops: [
      {
        stopName: String,
        order: Number,
        lat: Number,
        lng: Number
      }
    ],
    distance: { type: Number, default: 0 },
    snapped: { type: Boolean, default: false }
  },
  deviation: {
    maxMeters: { type: Number, required: true },
    fractionOff: { type: Number, required: true },
    sampleCount: { type: Number, required: true }
  },
  status: {
    type: String,
    enum: ['PENDING', 'RESOLVED'],
    default: 'PENDING',
    index: true
  },
  resolution: {
    type: String,
    enum: ['KEEP_OLD', 'ADOPT_NEW'],
    default: null
  }
}, {
  timestamps: true
});

routeChangeRequestSchema.index({ busId: 1, status: 1, createdAt: -1 });
routeChangeRequestSchema.index({ managerId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('RouteChangeRequest', routeChangeRequestSchema);
