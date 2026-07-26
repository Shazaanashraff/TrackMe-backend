const mongoose = require('mongoose');
const applyPasswordAuth = require('./passwordAuth');

// Common fields shared by every account type (SuperAdmin, Manager, Driver, User).
// Composed into each model's own schema instead of a base Mongoose model, since
// each account type needs to live in its own collection.
//
// These four models are *profiles*: one person (an `Identity`) may hold several of
// them — a rider who also drives. Credentials live on the Identity, not here. The
// credential fields below (`password`, `emailVerification`, `passwordReset`) are
// retained but **dormant** during the migration so a rollback stays possible; they
// are dropped once the identity model is settled in production. See
// docs/modules/AUTH.md.
//
// `email` is deliberately kept as a denormalised mirror of `Identity.email` — it is
// never user-editable (updateProfile touches name + phone only), so it cannot drift.
// Its `unique` index is per-collection, which is what lets one email hold a rider
// profile and a driver profile at the same time.
const applyAccountFields = (schema) => {
  schema.add({
    // The person this profile belongs to. The uniqueness constraint is declared as
    // a partial index below rather than `unique + sparse` here: a sparse unique
    // index skips *missing* fields but still treats explicit `null` as a value, so
    // two profiles written with `identityId: null` would collide.
    identityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Identity'
    },
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
    // Dormant — `Identity.password` is the real credential. Deliberately NOT
    // required: `attachProfile` adds a second role to an existing person and must
    // be able to create a profile with no password of its own.
    password: {
      type: String,
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

  // At most one profile of this role per identity, while leaving pre-migration
  // documents (no `identityId` at all) and any explicit nulls out of the index.
  schema.index(
    { identityId: 1 },
    { unique: true, partialFilterExpression: { identityId: { $type: 'objectId' } } }
  );

  applyPasswordAuth(schema);

  return schema;
};

module.exports = applyAccountFields;
