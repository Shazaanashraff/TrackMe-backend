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
