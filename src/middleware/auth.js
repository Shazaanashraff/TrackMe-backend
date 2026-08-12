const jwt = require('jsonwebtoken');
const { findAccountById } = require('../utils/accountRegistry');

// Verify JWT token
const protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({ message: 'Not authorized, no token' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const account = await findAccountById(decoded.id, decoded.role);

    if (!account) {
      return res.status(401).json({ message: 'User not found' });
    }

    req.user = account.doc;
    req.user.role = account.role;
    // The profile doc already carries this — no extra query. `|| null` so a
    // pre-migration profile with no identityId is an explicit null, never
    // `undefined`, which matters for the falsy-on-both-sides check in
    // requireOwnProfile below.
    req.identityId = account.doc.identityId || null;

    if (req.user.isActive === false) {
      return res.status(403).json({ message: 'Account is deactivated. Contact super admin.' });
    }

    next();
  } catch (error) {
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

// Attaches req.user if a valid Bearer token is present; never blocks the request.
// Used by endpoints that stay public for PUBLIC routes but need to recognize an
// authenticated member for PRIVATE routes (e.g. vehicle/ETA reads).
const optionalAuth = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return next();

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    const account = await findAccountById(decoded.id, decoded.role);
    if (account && account.doc.isActive !== false) {
      req.user = account.doc;
      req.user.role = account.role;
      req.identityId = account.doc.identityId || null;
    }
    next();
  } catch (error) {
    next();
  }
};

const requireRoles = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Not authorized' });
  }

  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ message: `Access denied. Allowed roles: ${roles.join(', ')}` });
  }

  next();
};

// Require driver role
const requireDriver = (req, res, next) => {
  if (req.user && req.user.role === 'driver') {
    next();
  } else {
    res.status(403).json({ message: 'Access denied. Driver role required.' });
  }
};

// Require user role
const requireUser = (req, res, next) => {
  if (req.user && req.user.role === 'user') {
    next();
  } else {
    res.status(403).json({ message: 'Access denied. User role required.' });
  }
};

// NOTE: the 'admin' role string identifies Manager profiles (see accountRegistry) — it is not
// the super-admin role. Reach for requireSuperAdmin, never requireManagerOrAbove, when a route
// must be restricted to super-admins only.
// Manager-or-super-admin gate. Previously named `requireAdmin`, which read as "admin role only"
// but actually granted both 'admin' (manager) and 'super-admin' — a footgun for anyone adding a
// genuinely super-admin-only route and reaching for the strictest-sounding name.
const requireManagerOrAbove = requireRoles('admin', 'super-admin');
// Manager-only gate ('admin' role string == Manager profile).
const requireManager = requireRoles('admin');
const requireSuperAdmin = requireRoles('super-admin');

// Guards a route parameter (default `:id`) naming a rider profile, so a
// caller can only ever act on a profile that shares their own identity — a
// parent's session reaching a stranger's child. 404s rather than 403s for
// both "no such profile" and "not yours", matching leaveEnrollment
// (enrollmentController.js) — a profile id is an opaque ObjectId to the
// caller either way, so there is nothing to leak by not distinguishing them.
//
// The comparison is written as two explicit falsy checks, not
// `String(a) === String(b)`. A pre-migration document (or, in principle, a
// caller whose own identityId somehow came back null) has `identityId:
// undefined`, and `String(undefined) === String(undefined)` is
// `'undefined' === 'undefined'` — true. That would make every profile-less
// legacy account a "member" of every other legacy account's household. A
// missing identity on *either* side must be a hard refusal, never a match.
const requireOwnProfile = (paramName = 'id') => async (req, res, next) => {
  try {
    // Lazy require: middleware/ is loaded before models/ are guaranteed to be
    // registered on some import orders, and only this guard needs User.
    const User = require('../models/User');

    if (!req.identityId) {
      return res.status(404).json({ success: false, message: 'Profile not found' });
    }

    const target = await User.findById(req.params[paramName]);
    if (!target || target.deletedAt) {
      return res.status(404).json({ success: false, message: 'Profile not found' });
    }

    if (!target.identityId || String(target.identityId) !== String(req.identityId)) {
      return res.status(404).json({ success: false, message: 'Profile not found' });
    }

    req.targetProfile = target;
    next();
  } catch (error) {
    next(error);
  }
};

// Restricts an action to the account holder — the profile that owns the
// login. Stops a stolen or leaked MANAGED-profile token from creating
// sibling profiles or deleting the primary out from under the account.
const requirePrimaryProfile = (req, res, next) => {
  if (!req.user || req.user.role !== 'user' || req.user.profileKind === 'MANAGED') {
    return res.status(403).json({
      success: false,
      code: 'MANAGED_PROFILE_FORBIDDEN',
      message: 'Only the account holder can do this'
    });
  }
  next();
};

module.exports = {
  protect,
  optionalAuth,
  requireRoles,
  requireDriver,
  requireUser,
  requireManagerOrAbove,
  requireManager,
  requireSuperAdmin,
  requireOwnProfile,
  requirePrimaryProfile
};
