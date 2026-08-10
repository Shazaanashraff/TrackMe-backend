const SuperAdmin = require('../models/SuperAdmin');
const Manager = require('../models/Manager');
const Driver = require('../models/Driver');
const User = require('../models/User');
const { normalizeDriverCode } = require('./driverCode');

// Central map of role -> the collection that role's accounts live in. This is the
// only place that needs to know all four account types exist; everything else
// (auth controller, middleware, socket auth) goes through the helpers below instead
// of picking a model directly.
const ACCOUNTS = [
  { role: 'super-admin', model: SuperAdmin },
  { role: 'admin', model: Manager },
  { role: 'driver', model: Driver },
  { role: 'user', model: User }
];

const modelForRole = (role) => ACCOUNTS.find((entry) => entry.role === role)?.model || null;

// Drivers can sign in with their permanent driver code instead of an email; many
// have no email at all, and (unlike the other three account types) they have no
// Identity login either — the driver code + password live directly on this
// collection. Only the driver collection has these codes.
const findAccountByDriverCode = async (code, { select } = {}) => {
  const normalized = normalizeDriverCode(code);
  if (!normalized) return null;

  let query = Driver.findOne({ driverCode: normalized });
  if (select) query = query.select(select);
  const doc = await query;

  return doc ? { doc, role: 'driver', model: Driver } : null;
};

const findAccountById = async (id, role, { select } = {}) => {
  const model = modelForRole(role);
  if (!model || !id) return null;

  let query = model.findById(id);
  if (select) query = query.select(select);
  const doc = await query;
  return doc ? { doc, role, model } : null;
};

// Scans all four collections for a matching email, regardless of whether that
// account is identity-linked. Used for the "does anybody already own this
// email" checks that must see driver-code drivers too (who have no Identity to
// check against) — e.g. a manager naming a driver, or refusing to hand a
// super-admin's email to a new bus account. Once a role is known, use
// findAccountById instead; for identity-linked accounts, identityRegistry's
// `isEmailRegistered` is the equivalent single-Identity-lookup check.
const isEmailRegistered = async (email, { excludeId, excludeRole } = {}) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return false;

  for (const { role, model } of ACCOUNTS) {
    const filter = { email: normalizedEmail };
    if (excludeId && (!excludeRole || excludeRole === role)) {
      filter._id = { $ne: excludeId };
    }
    // eslint-disable-next-line no-await-in-loop
    const exists = await model.exists(filter);
    if (exists) return true;
  }

  return false;
};

module.exports = {
  ACCOUNTS,
  modelForRole,
  findAccountByDriverCode,
  findAccountById,
  isEmailRegistered
};
