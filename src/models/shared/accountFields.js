const bcrypt = require('bcryptjs');

// Common fields shared by every account type (SuperAdmin, Manager, Driver, User).
// Composed into each model's own schema instead of a base Mongoose model, since
// each account type needs to live in its own collection.
const applyAccountFields = (schema) => {
  schema.add({
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
    avatarUrl: {
      type: String,
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
      otpHash: { type: String, default: null, select: false },
      expiresAt: { type: Date, default: null, select: false }
    },
    passwordReset: {
      otpHash: { type: String, default: null, select: false },
      expiresAt: { type: Date, default: null, select: false },
      resetTokenHash: { type: String, default: null, select: false },
      resetTokenExpiresAt: { type: Date, default: null, select: false }
    },
    refreshToken: {
      tokenHash: { type: String, default: null, select: false },
      expiresAt: { type: Date, default: null, select: false }
    }
  });

  schema.pre('save', async function hashPassword(next) {
    if (!this.isModified('password')) return next();
    this.password = await bcrypt.hash(this.password, 12);
    next();
  });

  schema.methods.comparePassword = async function comparePassword(candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
  };

  return schema;
};

module.exports = applyAccountFields;
