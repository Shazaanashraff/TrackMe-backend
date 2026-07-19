const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true
  },
  googleId: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  password: {
    type: String,
    required: function requiredPassword() {
      return !this.googleId;
    },
    minlength: 8,
    select: false
  },
  role: {
    type: String,
    enum: ['driver', 'user', 'admin', 'super-admin'],
    default: 'user'
  },
  phoneNumber: {
    type: String,
    trim: true,
    default: ''
  },
  // Profile picture stored as a self-contained data URL (data:image/...;base64,...)
  // so the app needs no external object store or credentials to hand off. Size is
  // capped in the controller (see MAX_AVATAR_BYTES). To scale later, swap this for
  // an https URL backed by S3/Cloudinary — userPayload already returns it verbatim.
  avatarUrl: {
    type: String,
    default: ''
  },
  // Set on province-manager (role: 'admin') accounts to scope which province's
  // routes/buses they manage. See scripts/assign-provinces-and-managers.js.
  province: {
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
  isActive: {
    type: Boolean,
    default: true
  },
  isEmailVerified: {
    type: Boolean,
    default: false
  },
  emailVerification: {
    otpHash: {
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
  passwordReset: {
    otpHash: {
      type: String,
      default: null,
      select: false
    },
    expiresAt: {
      type: Date,
      default: null,
      select: false
    },
    resetTokenHash: {
      type: String,
      default: null,
      select: false
    },
    resetTokenExpiresAt: {
      type: Date,
      default: null,
      select: false
    }
  },
  refreshToken: {
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
  // Expo push tokens for this account's device(s). Used to deliver QR boarding/
  // alighting notifications (see docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md).
  // This system has no separate parent/child model — the rider's own account is the
  // notification target.
  pushTokens: {
    type: [String],
    default: []
  },
  // Account-scoped QR attendance pass (see docs/features/qr-attendance/QR_SYSTEM.md).
  // One QR per user, valid across every route — bumping qrTokenVersion instantly
  // revokes every previously-issued pass (used by the rotate/regenerate endpoint).
  qrTokenVersion: {
    type: Number,
    default: 1
  },
  qrIssuedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
