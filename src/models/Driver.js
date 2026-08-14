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
  },
  // Whether redeeming this driver's enrollment key needs the manager's approval.
  // Public by default: holding the key is enough to enrol. When private, the key
  // only raises a request and the owning manager decides. See DriverEnrollment.
  isPrivate: {
    type: Boolean,
    default: false,
    index: true
  },
  // AES-GCM ciphertext of the driver's password, so the owning manager can read
  // it back and relay it to a driver who has no email. See
  // utils/recoverablePassword.js for why this exists and what it costs.
  //
  // `select: false` so it can never ride along on an ordinary driver query —
  // reading it must be a deliberate `.select('+passwordRecoverable')` on the one
  // endpoint that is allowed to. Authentication never touches it; the bcrypt
  // hash in `password` remains the only thing comparePassword checks.
  passwordRecoverable: {
    type: String,
    default: null,
    select: false
  }
}, { timestamps: true }), { emailOptional: true });

module.exports = mongoose.model('Driver', driverSchema);
