const mongoose = require('mongoose');
const applyAccountFields = require('./shared/accountFields');

const managerSchema = applyAccountFields(new mongoose.Schema({
  phoneNumber: {
    type: String,
    trim: true,
    default: ''
  },
  // Scopes which province's routes/vehicles this manager manages.
  // See scripts/assign-provinces-and-managers.js.
  province: {
    type: String,
    trim: true,
    default: ''
  },
  // Which transport service this manager is responsible for. PUBLIC managers
  // oversee public routes (scoped by province); SCHOOL/UNIVERSITY/OFFICE
  // managers belong to a specific `organization` below.
  serviceType: {
    type: String,
    enum: ['PUBLIC', 'SCHOOL', 'UNIVERSITY', 'OFFICE'],
    default: 'PUBLIC'
  },
  // The school/university/office this manager runs, for non-PUBLIC service types.
  // Null for PUBLIC managers.
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    default: null
  },
  // Manager provisioning (invite / password-reset by link). The super admin never
  // learns a manager's password: on invite we email a one-time link carrying this
  // token; the manager follows it to set their own password. `invitedAt` records
  // the invite; `activatedAt` is stamped the first time they set a password (so the
  // roster can show Invited vs Active). The token itself is stored hashed.
  accountSetup: {
    tokenHash: {
      type: String,
      default: null,
      select: false
    },
    expiresAt: {
      type: Date,
      default: null,
      select: false
    }
  },
  invitedAt: {
    type: Date,
    default: null
  },
  activatedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true }));

module.exports = mongoose.model('Manager', managerSchema);
