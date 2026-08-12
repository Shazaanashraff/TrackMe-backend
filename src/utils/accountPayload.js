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
      : null
});

// Re-hydrates the Identity a profile document points at, for the many
// `userPayload` call sites that only have the profile in hand. Without this,
// userPayload falls back to the profile's own (dormant, and on a managed
// rider profile always empty) `email`/`isEmailVerified` fields — the
// account's real email would silently blank out of the response.
const hydrateIdentity = async (user) => (user.identityId ? Identity.findById(user.identityId) : null);

module.exports = { userPayload, hydrateIdentity };
