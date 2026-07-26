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

// NOTE: there is deliberately no `findAccountByEmail` here any more. It returned the
// FIRST matching collection, which silently shadows every profile but one now that a
// person may hold several roles on one email. Resolving by email is
// identityRegistry's job: `findIdentityByEmail` + `resolveProfileForAudience`, which
// require the caller to say *which app* is asking.
const findAccountById = async (id, role, { select } = {}) => {
  const model = modelForRole(role);
  if (!model || !id) return null;

  let query = model.findById(id);
  if (select) query = query.select(select);
  const doc = await query;
  return doc ? { doc, role, model } : null;
};

// NOTE: `isEmailRegistered` lives in identityRegistry now, not here. The old version
// enforced "one email = one account type" — exactly the rule the identity model
// relaxes, since a rider may also be a driver or a manager. Asking whether an
// *Identity* owns the email is a single lookup instead of a four-collection scan.

module.exports = {
  ACCOUNTS,
  modelForRole,
  findAccountById
};
