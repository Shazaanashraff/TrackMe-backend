const jwt = require('jsonwebtoken');
const User = require('../models/User');

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

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id);

    if (!req.user) {
      return res.status(401).json({ message: 'User not found' });
    }

    if (req.user.isActive === false) {
      return res.status(403).json({ message: 'Account is deactivated. Contact super admin.' });
    }

    next();
  } catch (error) {
    return res.status(401).json({ message: 'Not authorized, token failed' });
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

const requireAdmin = requireRoles('admin', 'super-admin');
const requireManager = requireRoles('admin');
const requireSuperAdmin = requireRoles('super-admin');

module.exports = {
  protect,
  requireRoles,
  requireDriver,
  requireUser,
  requireAdmin,
  requireManager,
  requireSuperAdmin
};
