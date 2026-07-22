const SuperAdmin = require('../models/SuperAdmin');
const Manager = require('../models/Manager');
const Driver = require('../models/Driver');
const User = require('../models/User');

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

// Scans all four collections for a matching email. Only used where the caller
// doesn't already know the role (login, registration uniqueness, password reset
// by email). Once a role is known (e.g. from a JWT), use findAccountById instead.
const findAccountByEmail = async (email, { select } = {}) => {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return null;

  for (const { role, model } of ACCOUNTS) {
    let query = model.findOne({ email: normalizedEmail });
    if (select) query = query.select(select);
    // eslint-disable-next-line no-await-in-loop
    const doc = await query;
    if (doc) return { doc, role, model };
  }

  return null;
};

const findAccountById = async (id, role, { select } = {}) => {
  const model = modelForRole(role);
  if (!model || !id) return null;

  let query = model.findById(id);
  if (select) query = query.select(select);
  const doc = await query;
  return doc ? { doc, role, model } : null;
};

// Cross-collection uniqueness check used before creating/renaming any account so
// no two account types (e.g. a rider and a manager) can share an email.
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
  findAccountByEmail,
  findAccountById,
  isEmailRegistered
};
