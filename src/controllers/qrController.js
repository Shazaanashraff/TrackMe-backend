// Rider-facing QR endpoints — see docs/features/qr-attendance/QR_ATTENDANCE_PLAN.md.
const jwt = require('jsonwebtoken');
const RouteMembership = require('../models/RouteMembership');
const Route = require('../models/Route');
const { signQr } = require('../utils/qrToken');

function toIssuedToken(membership) {
  const { token, payload } = signQr(membership);
  const decoded = jwt.decode(token);
  return {
    membershipId: String(membership._id),
    routeId: membership.routeId,
    token,
    tokenVersion: payload.ver,
    issuedAt: new Date().toISOString(),
    expiresAt: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null
  };
}

// @desc    Issue fresh QR token(s) for the caller's ACTIVE membership(s)
// @route   POST /api/qr/issue
// body: { routeId? } — scope to one membership; omitted = all ACTIVE memberships.
exports.issueQr = async (req, res, next) => {
  try {
    const filter = { userId: req.user._id, status: 'ACTIVE' };
    const routeId = req.body?.routeId ? String(req.body.routeId).toUpperCase() : null;
    if (routeId) filter.routeId = routeId;

    const memberships = await RouteMembership.find(filter);
    if (routeId && memberships.length === 0) {
      return res.status(404).json({ success: false, message: 'Active membership not found for this route' });
    }

    const now = new Date();
    const issued = [];
    for (const membership of memberships) {
      const entry = toIssuedToken(membership);
      issued.push(entry);
      membership.qrIssuedAt = now;
      // eslint-disable-next-line no-await-in-loop
      await membership.save();
    }

    return res.status(200).json({ success: true, count: issued.length, data: issued });
  } catch (error) {
    next(error);
  }
};

// @desc    Bump a membership's tokenVersion, revoking every previously-issued QR
// @route   POST /api/qr/rotate
// body: { routeId, userId? } — userId is manager-only (rotate a member's QR on their own route).
exports.rotateQr = async (req, res, next) => {
  try {
    const routeId = String(req.body?.routeId || '').toUpperCase();
    if (!routeId) {
      return res.status(400).json({ success: false, message: 'routeId is required' });
    }

    let targetUserId = req.user._id;
    const isManager = ['admin', 'super-admin'].includes(req.user.role);

    if (req.body?.userId && req.body.userId !== String(req.user._id)) {
      if (!isManager) {
        return res.status(403).json({ success: false, message: 'Only a manager can rotate another rider\'s QR' });
      }
      const route = await Route.findOne({ routeId, isDeleted: false });
      if (!route || String(route.managerId) !== String(req.user._id)) {
        return res.status(403).json({ success: false, message: 'You do not manage this route' });
      }
      targetUserId = req.body.userId;
    }

    const membership = await RouteMembership.findOneAndUpdate(
      { userId: targetUserId, routeId, status: 'ACTIVE' },
      { $inc: { tokenVersion: 1 } },
      { new: true }
    );

    if (!membership) {
      return res.status(404).json({ success: false, message: 'Active membership not found for this route' });
    }

    return res.status(200).json({
      success: true,
      data: { membershipId: String(membership._id), routeId: membership.routeId, tokenVersion: membership.tokenVersion }
    });
  } catch (error) {
    next(error);
  }
};
