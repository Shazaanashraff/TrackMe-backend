const mongoose = require('mongoose');
const applyAccountFields = require('./shared/accountFields');

const superAdminSchema = applyAccountFields(new mongoose.Schema({}, { timestamps: true }));

module.exports = mongoose.model('SuperAdmin', superAdminSchema);
