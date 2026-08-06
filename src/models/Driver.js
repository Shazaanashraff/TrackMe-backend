const mongoose = require('mongoose');
const applyAccountFields = require('./shared/accountFields');

const driverSchema = applyAccountFields(new mongoose.Schema({
  // The driver's permanent sign-in ID (e.g. DRV-4K7P-9XQ2), generated once at
  // creation and never rotated. Drivers may have no email at all, so this is
  // the identifier that is always present. Sparse because drivers created
  // before this field existed have none until the backfill script runs.
  // No default: a sparse index skips only *missing* fields, so an explicit null
  // default would put every code-less driver in the index under the same key.
  driverCode: {
    type: String,
    unique: true,
    sparse: true,
    trim: true,
    uppercase: true
  },
  // The school / university / office this driver drives for. Null for drivers
  // on public service, which has no organization.
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    default: null,
    index: true
  },
  phoneNumber: {
    type: String,
    trim: true,
    default: ''
  },
  nicNumber: {
    type: String,
    trim: true,
    default: ''
  },
  licenseCardNumber: {
    type: String,
    trim: true,
    default: ''
  },
  // Owning manager. A driver belongs to a manager directly rather than only
  // through an assigned vehicle, so the manager's driver directory can list
  // drivers who have not been given a vehicle yet.
  managerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Manager',
    default: null,
    index: true
  }
}, { timestamps: true }), { emailOptional: true });

module.exports = mongoose.model('Driver', driverSchema);
