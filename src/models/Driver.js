const mongoose = require('mongoose');
const applyAccountFields = require('./shared/accountFields');

const driverSchema = applyAccountFields(new mongoose.Schema({
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
}, { timestamps: true }));

module.exports = mongoose.model('Driver', driverSchema);
