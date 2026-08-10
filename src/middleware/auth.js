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

module.exports = {
  protect,
  optionalAuth,
  requireRoles,
  requireDriver,
  requireUser,
  requireManagerOrAbove,
  requireManager,
  requireSuperAdmin
};
