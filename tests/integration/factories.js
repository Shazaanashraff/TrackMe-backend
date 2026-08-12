const request = require('supertest');
const app = require('../../src/server');
const { createIdentityWithProfile } = require('../../src/utils/identityRegistry');

// Account factories for the integration suites.
//
// Credentials live on `Identity`, not on the role profile, so building a test
// account with `Manager.create({ email, password })` produces a document that
// looks right in the database and cannot log in — every request that follows
// then fails with a misleading 401. That is the same trap that retired the old
// seed scripts (see backend/CLAUDE.md, "Running"). Going through
// `createIdentityWithProfile` here is what keeps a suite honest: the account is
// built by the same path the real application uses.
//
// Every factory returns `{ id, doc, identity, email, password, token }` so a
// suite can assert on the document, reuse the id as a foreign key, and send the
// token straight to an endpoint.

const DEFAULT_PASSWORD = 'P@ssw0rd!';

// Suites run serially against one shared database and several reuse the same
// display names, so the address has to be unique per call, not per suite.
let seq = 0;
const uniqueEmail = (prefix) =>
  `${prefix}-${Date.now()}-${seq++}-${Math.random().toString(36).slice(2, 8)}@test.com`;

// Which app each role signs in from. Sent explicitly rather than relying on the
// no-audience legacy fallback, which resolves by role precedence — that would
// silently hand a driver session to a test person who is also a rider.
const AUDIENCE_FOR_ROLE = {
  user: 'user',
  driver: 'driver',
  admin: 'manager',
  'super-admin': 'super-admin'
};

async function login(email, password = DEFAULT_PASSWORD, audience) {
  return request(app).post('/api/auth/login').send({ email, password, audience });
}

// Sign in with a driver's permanent code instead of an email. Drivers are the one
// account type that authenticates against the profile document rather than an
// Identity, so this deliberately does not go through `login` above.
async function loginWithDriverCode(driverCode, password = DEFAULT_PASSWORD) {
  return request(app)
    .post('/api/auth/login')
    .send({ identifier: driverCode, password, audience: 'driver' });
}

/**
 * Create one account of `role` and (by default) sign it in.
 *
 * @param {'user'|'driver'|'admin'|'super-admin'} role
 * @param {object} [options]
 * @param {string} [options.name]            display name on the profile
 * @param {string} [options.email]           defaults to a unique test address
 * @param {string} [options.password]
 * @param {boolean} [options.isEmailVerified] defaults true so the account can log in
 * @param {object} [options.fields]          extra profile fields (serviceType,
 *                                           organization, managerId, phoneNumber…)
 * @param {boolean} [options.signIn]         set false to skip the login round-trip
 */
async function createAccount(role, options = {}) {
  const {
    name = `Test ${role}`,
    email = uniqueEmail(role),
    password = DEFAULT_PASSWORD,
    isEmailVerified = true,
    fields = {},
    signIn = true
  } = options;

  const { identity, doc } = await createIdentityWithProfile({
    email,
    password,
    isEmailVerified,
    role,
    fields: { name, ...fields }
  });

  let token = null;
  if (signIn) {
    const res = await login(email, password, AUDIENCE_FOR_ROLE[role]);
    token = res.body.accessToken || null;
    if (!token) {
      // Failing here beats returning a null token and letting the suite report
      // a 401 from whichever endpoint it happened to call first.
      throw new Error(
        `factories: could not sign in the ${role} just created `
        + `(${res.status} ${JSON.stringify(res.body)})`
      );
    }
  }

  return { id: doc._id, doc, identity, email, password, token };
}

const createRider = (options) => createAccount('user', options);
const createDriver = (options) => createAccount('driver', options);
const createManager = (options) => createAccount('admin', options);
const createSuperAdmin = (options) => createAccount('super-admin', options);

// `.set(...authHeader(token))` — matches the `.set(...auth())` shape the suites
// already use.
const authHeader = (token) => ['Authorization', `Bearer ${token}`];

module.exports = {
  DEFAULT_PASSWORD,
  uniqueEmail,
  login,
  loginWithDriverCode,
  createAccount,
  createRider,
  createDriver,
  createManager,
  createSuperAdmin,
  authHeader
};
