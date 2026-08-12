const bcrypt = require('bcryptjs');

// Common fields shared by every account type (SuperAdmin, Manager, Driver, User).
// Composed into each model's own schema instead of a base Mongoose model, since
// each account type needs to live in its own collection.
//
// `emailOptional` is for account types that have another way to sign in (drivers
// have a driver code). The index then has to be sparse, since a plain unique
// index counts every missing email as the same null and would allow only one
// email-less account.
const applyAccountFields = (schema, { emailOptional = false } = {}) => {
  schema.add({
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true
    },
    email: emailOptional ? {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      // Blank means "no email", not an empty-string email that would collide
      // with every other blank one.
      set: (value) => {
        const trimmed = String(value ?? '').trim();
        return trimmed === '' ? undefined : trimmed;
      }
    } : {
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
      attempts: { type: Number, default: 0, select: false },
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
