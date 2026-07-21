const mongoose = require('mongoose');
const applyAccountFields = require('./shared/accountFields');

const managerSchema = applyAccountFields(new mongoose.Schema({
  phoneNumber: {
    type: String,
    trim: true,
    default: ''
  },
  // Scopes which province's routes/buses this manager manages.
  // See scripts/assign-provinces-and-managers.js.
  province: {
    type: String,
    trim: true,
    default: ''
  }
}, { timestamps: true }));

module.exports = mongoose.model('Manager', managerSchema);
