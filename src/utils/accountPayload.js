// The client-facing shape of an account profile, extracted out of
// authController.js so profileController's switchProfile can hand back the
// exact same shape login/refresh do — the client's response handling must
// not need to know which endpoint it called.
const Identity = require('../models/Identity');

// `identity` is optional so the two profile-only flows (refresh, logout) can keep
// calling this without a second lookup. When present it is the source of truth for
// `isEmailVerified`, which now belongs to the person rather than to one of their roles.
const userPayload = (user, role, identity = null) => ({
  _id: user._id,
  name: user.name,
  email: identity?.email || user.email || '',
  // Drivers sign in with this and it is shown in their profile; absent on
  // every other role.
  ...(user.driverCode ? { driverCode: user.driverCode } : {}),
  // Present only on `user` — undefined (dropped by JSON.stringify) elsewhere.
  // Tells the client which profile it is looking at without a second call:
  // MANAGED profiles hide the phone field and can't create/delete siblings.
  ...(user.profileKind ? { profileKind: user.profileKind } : {}),
  phoneNumber: user.phoneNumber,
  avatarUrl: user.avatarUrl || '',
  role,
  isEmailVerified: identity ? identity.isEmailVerified : user.isEmailVerified,
  // Drives service-aware UI (e.g. a school manager sees "Vehicles", not "Buses").
  // Always present for managers; harmless (PUBLIC/null) for other roles.
  serviceType: user.serviceType || 'PUBLIC',
  organization:
    user.organization && user.organization.name
      ? { _id: user.organization._id, name: user.organization.name }
      : null,
  // Whether this login has a password to change. A Google-only login has none,
  // and the rider app hides "Change password" for it.
  ...(identity ? { hasPassword: hasPassword(identity) } : {}),
  // Set only while a rider account waits to be deleted; the rider app shows the
  // keep-or-continue screen instead of the app while it is present.
  ...(role === 'user' ? { pendingDeletion: user.deletion?.purgeAt ? { purgeAt: user.deletion.purgeAt } : null } : {})
});

// `password` is select:false. When the caller loaded it, it is the answer; when
// it did not, a login with no Google link must have a password (Identity.js
// requires one), and a Google-linked one is assumed to have none.
const hasPassword = (identity) => {
  if (identity.password !== undefined) return Boolean(identity.password);
  return !identity.googleId;
};

// Re-hydrates the Identity a profile document points at, for the many
// `userPayload` call sites that only have the profile in hand. Without this,
// userPayload falls back to the profile's own (dormant, and on a managed
// rider profile always empty) `email`/`isEmailVerified` fields — the
// account's real email would silently blank out of the response.
// `+password` is read only so `hasPassword` is exact; it never leaves this process.
const hydrateIdentity = async (user) => (user.identityId ? Identity.findById(user.identityId).select('+password') : null);

module.exports = { userPayload, hydrateIdentity, hasPassword };
