const mongoose = require('mongoose');

// A passenger's link to a driver, created by redeeming that driver's enrollment key.
//
// One record serves as both the request and the membership. A public driver's key
// lands straight in ACTIVE; a private driver's key lands in PENDING until the owning
// manager decides. Keeping them in one document means there is no separate request
// row to fall out of sync with the membership it granted.
const driverEnrollmentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    driverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Driver',
      required: true,
      index: true
    },
    // Denormalised from the driver so the manager's pending queue is a single
    // indexed query rather than a lookup through every driver they own. Set from
    // the driver at redeem time and moved by the same code that reassigns a driver.
    managerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Manager',
      default: null,
      index: true
    },
    status: {
      type: String,
      enum: ['PENDING', 'ACTIVE', 'REJECTED'],
      default: 'PENDING',
      index: true
    },
    // Whether the driver was private when the key was redeemed. Recorded because
    // a manager may flip the flag afterwards, and a request already in the queue
    // should still read as one that needed approval.
    requiredApproval: {
      type: Boolean,
      default: false
    },
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Manager',
      default: null
    },
    decidedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

// One record per passenger per driver. A second redeem of the same key updates this
// row rather than stacking duplicates, so a passenger cannot flood the queue.
driverEnrollmentSchema.index({ userId: 1, driverId: 1 }, { unique: true });

// The manager queue: pending first, newest first.
driverEnrollmentSchema.index({ managerId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('DriverEnrollment', driverEnrollmentSchema);
