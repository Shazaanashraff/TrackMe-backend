const Identity = require('../models/Identity');
const { ACCOUNTS, modelForRole } = require('./accountRegistry');

// Resolves one person (an `Identity`) to the role profiles they hold.
//
// `accountRegistry` answers "given a role and an id, which document?" — it stays the
// lookup used by `protect`. This module answers "given an email, who is this person
// and which apps may they sign into?", which is the question that changed when one
// email became allowed to hold several roles. See docs/modules/AUTH.md.

// Each app declares what it is; login resolves the profile that matches. Order
// within a list is precedence: web-admin serves super-admins and managers from the
// same portal, and a super-admin outranks a manager.
const AUDIENCE_ROLES = {
  user: ['user'],
  rider: ['user'],
  driver: ['driver'],
  admin: ['super-admin', 'admin'],
  'web-admin': ['super-admin', 'admin'],
  manager: ['admin'],
  'super-admin': ['super-admin']
};

// The order `findAccountByEmail` used to scan collections in. Retained purely as the
// fallback for requests that send no `audience`, so an app build released before this
// change behaves exactly as it did before.
const LEGACY_ROLE_PRECEDENCE = ACCOUNTS.map((entry) => entry.role);

const VALID_AUDIENCES = Object.keys(AUDIENCE_ROLES);

class SuperAdminIsolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SuperAdminIsolationError';
    this.code = 'SUPER_ADMIN_ISOLATED';
  }
}

// --- Pure helpers (unit-tested without a database) ---

// Given the roles a person actually holds and the app asking, pick the role to issue
// a token for. Returns null when this person has no profile for that app — the caller
// turns that into 403 NO_PROFILE_FOR_APP rather than a misleading "wrong password".
const selectRoleForAudience = (profileRoles, audience) => {
  const held = new Set(profileRoles || []);
  const preference = audience
    ? AUDIENCE_ROLES[String(audience).toLowerCase()]
    : LEGACY_ROLE_PRECEDENCE;

  if (!preference) return null;
  return preference.find((role) => held.has(role)) || null;
};

// A super-admin may not share a login with any other role: one leaked password must
// never be able to reach the highest-privilege account. Enforced here so every
// creation path (register, Google, admin provisioning, seed scripts) inherits it.
const assertShareable = (existingRoles, newRole) => {
  const held = existingRoles || [];
  if (newRole === 'super-admin' && held.length > 0) {
    throw new SuperAdminIsolationError(
      'A super-admin must use a dedicated email that holds no other role'
    );
  }
  if (held.includes('super-admin')) {
    throw new SuperAdminIsolationError(
      'This email belongs to a super-admin and cannot take on additional roles'
    );
  }
  return true;
};

// --- Database-backed lookups ---

const findIdentityByEmail = async (email, { select } = {}) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;

  let query = Identity.findOne({ email: normalizedEmail });
  if (select) query = query.select(select);
  return query;
};

// Every profile this identity holds, in ACCOUNTS precedence order.
const findProfilesForIdentity = async (identityId, { select } = {}) => {
  if (!identityId) return [];

  const found = await Promise.all(
    ACCOUNTS.map(async ({ role, model }) => {
      let query = model.findOne({ identityId });
      if (select) query = query.select(select);
      const doc = await query;
      return doc ? { doc, role, model } : null;
    })
  );

  return found.filter(Boolean);
};

const rolesForIdentity = async (identityId) =>
  (await findProfilesForIdentity(identityId)).map((entry) => entry.role);

const hasSuperAdminProfile = async (identityId) => {
  if (!identityId) return false;
  return Boolean(await modelForRole('super-admin').exists({ identityId }));
};

// Resolve the single profile an app should sign in, or null if this person has none
// for that app.
const resolveProfileForAudience = async (identityId, audience, { select } = {}) => {
  const profiles = await findProfilesForIdentity(identityId, { select });
  const role = selectRoleForAudience(profiles.map((p) => p.role), audience);
  if (!role) return null;
  return profiles.find((p) => p.role === role) || null;
};

// --- Writes ---

// Add a role to a person who already has a login. Never writes credentials: the
// caller's password (e.g. one an admin typed into "Add Manager") is deliberately
// ignored, because the person already owns this identity.
const attachProfile = async ({ identityId, role, fields = {} }) => {
  const model = modelForRole(role);
  if (!model) throw new Error(`Unknown role: ${role}`);

  const identity = await Identity.findById(identityId);
  if (!identity) throw new Error('Identity not found');

  assertShareable(await rolesForIdentity(identityId), role);

  const existing = await model.findOne({ identityId });
  if (existing) return { doc: existing, role, model, created: false };

  const doc = await model.create({
    ...fields,
    identityId,
    // Mirrors Identity.email so `userPayload` and admin lists keep working unchanged.
    email: identity.email
  });

  return { doc, role, model, created: true };
};

// Create a brand-new person and their first role profile.
const createIdentityWithProfile = async ({
  email,
  password,
  googleId,
  isEmailVerified = false,
  isProvisional = false,
  role,
  fields = {}
}) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const model = modelForRole(role);
  if (!model) throw new Error(`Unknown role: ${role}`);

  const identity = await Identity.create({
    email: normalizedEmail,
    password,
    googleId,
    isEmailVerified,
    isProvisional
  });

  const doc = await model.create({
    ...fields,
    identityId: identity._id,
    email: normalizedEmail
  });

  return { identity, doc, role, model, created: true };
};

// Cross-role email uniqueness now means "does anyone own this login", which is a
// single Identity lookup rather than a scan of four collections.
const isEmailRegistered = async (email, { excludeIdentityId } = {}) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return false;

  const filter = { email: normalizedEmail };
  if (excludeIdentityId) filter._id = { $ne: excludeIdentityId };

  return Boolean(await Identity.exists(filter));
};

module.exports = {
  AUDIENCE_ROLES,
  LEGACY_ROLE_PRECEDENCE,
  VALID_AUDIENCES,
  SuperAdminIsolationError,
  selectRoleForAudience,
  assertShareable,
  findIdentityByEmail,
  findProfilesForIdentity,
  rolesForIdentity,
  hasSuperAdminProfile,
  resolveProfileForAudience,
  attachProfile,
  createIdentityWithProfile,
  isEmailRegistered
};
