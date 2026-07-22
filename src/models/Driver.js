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
  }
}, { timestamps: true }));

module.exports = mongoose.model('Driver', driverSchema);
