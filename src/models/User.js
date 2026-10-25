const mongoose = require('mongoose');
const applyAccountFields = require('./shared/accountFields');

const userSchema = applyAccountFields(new mongoose.Schema({
  // PRIMARY  — the account holder. Owns the mirrored Identity.email, the phone
  //            number, and the device push tokens.
  // MANAGED  — a rider the account holder added (a child, a second commuter, an
  //            employee). No email, no credentials, no login of its own —
  //            reached only by switching profiles from the PRIMARY's session.
  //            See utils/identityRegistry.js and docs/modules/PROFILES.md.
  //
  // An enum, not a boolean: reads better at every call site, and `default:
  // 'PRIMARY'` is deliberate — a managed profile created without an explicit
  // kind collides with the unique index below (E11000) rather than silently
  // becoming a second primary.
  profileKind: {
    type: String,
    enum: ['PRIMARY', 'MANAGED'],
    default: 'PRIMARY',
    required: true
  },
  // Free text ("Son", "Daughter", "Staff") shown next to a managed profile in
  // the switcher. No enum: this spans school, office and any other shuttle, not
  // just families.
  relation: {
    type: String,
    trim: true,
    default: ''
  },
  // Soft delete. A profile can be deactivated (isActive: false, set below) once
  // it has ridden — its BoardingEvent/DriverEnrollment history must survive —
  // but `deletedAt` marks it as gone for the switcher and household reads to
  // filter on, distinct from the isActive flag drivers/managers also use.
  deletedAt: {
    type: Date,
    default: null
  },
  phoneNumber: {
    type: String,
    trim: true,
    default: ''
  },
  // Expo push tokens for this account's device(s). Only ever populated on the
  // PRIMARY profile — a managed profile has no device of its own, so boarding
  // pushes for it resolve tokens across the whole household instead (see
  // utils/pushHelper.js).
  pushTokens: {
    type: [String],
    default: []
  },
  // Account-scoped QR attendance pass (see docs/features/qr-attendance/QR_SYSTEM.md).
  // One QR per profile — a managed profile gets its own pass, valid across every
  // route. Bumping qrTokenVersion instantly revokes every previously-issued pass
  // (used by the rotate/regenerate endpoint, and by soft-deleting a profile).
  qrTokenVersion: {
    type: Number,
    default: 1
  },
  qrIssuedAt: {
    type: Date,
    default: null
  },
  // Set on the PRIMARY profile only, when the account holder asks for their
  // account to be deleted (services/accountDeletion.js). Until `purgeAt` the
  // account can be kept by signing in again; after it, the household is purged.
  // `enrollmentSnapshot` holds the enrollments that were ended at the request,
  // so keeping the account can put them back exactly as they were.
  deletion: {
    requestedAt: { type: Date, default: null },
    purgeAt: { type: Date, default: null },
    enrollmentSnapshot: { type: [mongoose.Schema.Types.Mixed], default: undefined, select: false }
  }
}, { timestamps: true }), { emailOptional: true, multiplePerIdentity: true });

// The purge sweep's query. Partial, so the index holds only the handful of
// accounts that are actually waiting to be deleted.
userSchema.index(
  { 'deletion.purgeAt': 1 },
  { name: 'deletion_purgeAt_pending', partialFilterExpression: { 'deletion.purgeAt': { $type: 'date' } } }
);

// Exactly one PRIMARY rider profile per identity — the constraint that used to
// live in accountFields.js for every role, now scoped so managed profiles can
// share the identity freely. Pre-migration documents (no identityId at all)
// stay out of the index, same as the shared one.
//
// Named explicitly: accountFields.js already declares a plain `identityId: 1`
// index for the household lookups (multiplePerIdentity branch), and Mongoose
// would otherwise auto-name both indexes `identityId_1` and collide.
userSchema.index(
  { identityId: 1 },
  {
    name: 'identityId_1_primary_unique',
    unique: true,
    partialFilterExpression: { identityId: { $type: 'objectId' }, profileKind: 'PRIMARY' }
  }
);

// `emailOptional` drops the collection-wide `required: true` on email so a
// managed profile can have none; this re-asserts the rule per kind, since
// "primary" and "managed" want opposite answers. A `pre('validate')` hook
// rather than a path validator — a path validator only runs when that path
// has a value, so it would never catch a PRIMARY created with no email at all.
userSchema.pre('validate', function enforceEmailByProfileKind(next) {
  if (this.profileKind === 'PRIMARY' && !this.email) {
    this.invalidate('email', 'A primary rider profile must carry the account email');
  }
  if (this.profileKind === 'MANAGED' && this.email) {
    this.invalidate('email', 'A managed rider profile cannot have its own email');
  }
  next();
});

module.exports = mongoose.model('User', userSchema);
