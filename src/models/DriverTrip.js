const mongoose = require('mongoose');

// A completed driver journey. This replaced the old DriverEarnings model when the
// earnings/payout concept was removed (2026-08-07). The money fields (grossEarnings,
// commission, netEarnings, deductions, bonusEarnings, paymentStatus, paymentDate,
// paymentMethod, bankAccount) are gone; what remains is the trip log itself.
//
// The collection is pinned to the legacy `driverearnings` name so existing trip
// documents stay visible. Renaming the collection would orphan them, and that is a
// data-migration decision, not a code one.
const DriverTripSchema = new mongoose.Schema({
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    required: true,
    index: true
  },
  vehicleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vehicle',
    required: true,
    index: true
  },
  tripId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  routeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Route',
    required: true
  },
  journeyDate: {
    type: Date,
    required: true,
    index: true
  },
  startTime: {
    type: Date,
    required: true
  },
  endTime: {
    type: Date,
    default: null
  },
  totalDistance: {
    type: Number,
    default: 0
  },
  totalPassengers: {
    type: Number,
    default: 0,
    index: true
  },
  notes: String,
  status: {
    type: String,
    enum: ['ACTIVE', 'CANCELLED', 'DISPUTED'],
    default: 'ACTIVE'
  }
}, { timestamps: true });

// Indexes for performance
DriverTripSchema.index({ driverId: 1, journeyDate: -1 });

module.exports = mongoose.model('DriverTrip', DriverTripSchema, 'driverearnings');
