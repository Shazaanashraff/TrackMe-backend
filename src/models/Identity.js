const mongoose = require('mongoose');
const applyPasswordAuth = require('./shared/passwordAuth');

// An Identity is **one person's login**. It owns the email, the password, and the
// email-verification / password-reset state — nothing role-specific.
//
// The four account models (User, Driver, Manager, SuperAdmin) are *profiles* that
// point at an Identity via `identityId`. One person may hold several: a rider who
// also drives signs into user-app and driver-app with the same credentials, and a
// password reset covers both. This mirrors how a single Uber account works across
// the rider and driver apps. See docs/modules/AUTH.md.
//
// Two invariants that are enforced elsewhere but belong in your head when reading
// this file:
//   1. `super-admin` may not share an Identity with any other role — enforced in
//      utils/identityRegistry.js, not by the schema.
//   2. Sessions are per-profile: `refreshToken` deliberately stays on the profile
//      documents so signing out of one app does not sign you out of the others.
const identitySchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    // A Google-only identity has no password until the person sets one.
    required: function requiredPassword() {
      return !this.googleId;
    },
    minlength: 8,
    select: false
  },
  googleId: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  isEmailVerified: {
    type: Boolean,
    default: false
  },
  // True while this login was created *for* someone by an admin (a manager
  // provisioning a driver, a super-admin adding a manager) and that person has
  // not signed in or reset their password yet.
  //
  // This is the gate that makes admin-set passwords safe: an admin may write
  // `password` only while the identity is provisional. Once the person has used
  // the login it becomes theirs, and admin "reset password" actions must send a
  // reset email instead of overwriting — otherwise a manager could set a password
  // on an email that also holds that person's rider account and take it over.
  isProvisional: {
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
  }
}, { timestamps: true });

applyPasswordAuth(identitySchema);

module.exports = mongoose.model('Identity', identitySchema);
