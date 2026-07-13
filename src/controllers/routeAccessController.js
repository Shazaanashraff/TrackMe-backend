// Passenger-side endpoints for the Private Routes (room-key / PIN) feature.
// All authenticated — see PRIVATE_ROUTES_PLAN.md §5.2.
const Route = require('../models/Route');
const RouteMembership = require('../models/RouteMembership');
const RouteJoinRequest = require('../models/RouteJoinRequest');
const RouteKeyAttempt = require('../models/RouteKeyAttempt');
const { verifyCode, lookupHash } = require('../utils/roomKey');
const { createNotification } = require('../utils/notificationHelper');

const MAX_ATTEMPTS = Number(process.env.ROOM_KEY_MAX_ATTEMPTS) || 5;
// Escalating backoff tiers (seconds), one lockout per MAX_ATTEMPTS wrong attempts.
const LOCK_TIERS_SECONDS = [60, 300, 1800];

const routeSummary = (route) => ({
  routeId: route.routeId,
  routeName: route.routeName,
  source: route.source,
  destination: route.destination,
  serviceType: route.serviceType,
  joinApprovalRequired: route.joinApprovalRequired
});

// @desc    Verify a room-key code and grant/queue access to a PRIVATE route
// @route   POST /api/routes/join/verify
exports.verifyRoomKey = async (req, res, next) => {
  try {
    const { routeId, code } = req.body || {};
    if (!code || !/^\d{6}$/.test(String(code))) {
      return res.status(400).json({ success: false, message: 'A 6-digit code is required' });
    }

    const route = routeId
      ? await Route.findOne({ routeId: String(routeId).toUpperCase(), isDeleted: false, visibility: 'PRIVATE' })
      : await Route.findOne({ 'roomKey.lookupHash': lookupHash(code), isDeleted: false, visibility: 'PRIVATE' });

    if (!route) {
      return res.status(404).json({ success: false, message: 'Route not found' });
    }

    const attemptKey = { userId: req.user._id, routeId: route.routeId };
    let attempt = await RouteKeyAttempt.findOne(attemptKey);
    const now = new Date();
    if (attempt?.lockedUntil && attempt.lockedUntil > now) {
      const retryAfter = Math.ceil((attempt.lockedUntil.getTime() - now.getTime()) / 1000);
      return res.status(429).json({ success: false, message: 'Too many attempts. Try again later.', retryAfter });
    }

    const valid = verifyCode(code, route.roomKey);
    if (!valid) {
      attempt = await RouteKeyAttempt.findOneAndUpdate(
        attemptKey,
        { $inc: { count: 1 } },
        { upsert: true, new: true }
      );
      let lockedUntil = null;
      if (attempt.count > 0 && attempt.count % MAX_ATTEMPTS === 0) {
        const tier = Math.min(Math.floor(attempt.count / MAX_ATTEMPTS) - 1, LOCK_TIERS_SECONDS.length - 1);
        lockedUntil = new Date(now.getTime() + LOCK_TIERS_SECONDS[tier] * 1000);
        attempt.lockedUntil = lockedUntil;
        await attempt.save();
      }
      return res.status(403).json({
        success: false,
        message: 'Incorrect code',
        ...(lockedUntil ? { retryAfter: Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000) } : {})
      });
    }

    // Correct code — reset the attempt counter.
    await RouteKeyAttempt.findOneAndUpdate(attemptKey, { $set: { count: 0, lockedUntil: null } }, { upsert: true });

    if (route.joinApprovalRequired) {
      // Correct PIN alone is not enough — create (or reuse) a pending request.
      const existingMembership = await RouteMembership.findOne({ userId: req.user._id, routeId: route.routeId, status: 'ACTIVE' });
      if (existingMembership) {
        return res.status(200).json({ success: true, data: { access: 'GRANTED', route: routeSummary(route) } });
      }

      let joinRequest = await RouteJoinRequest.findOne({ userId: req.user._id, routeId: route.routeId, status: 'PENDING' });
      if (!joinRequest) {
        joinRequest = await RouteJoinRequest.create({
          userId: req.user._id,
          routeId: route.routeId,
          managerId: route.managerId,
          status: 'PENDING',
          pinVerified: true
        });
        await createNotification(
          route.managerId,
          'ROUTE_ACCESS_REQUEST',
          'New route access request',
          `A rider requested access to route ${route.routeId}.`,
          { routeId: route.routeId }
        );
      }

      return res.status(200).json({ success: true, data: { access: 'PENDING_APPROVAL', route: routeSummary(route) } });
    }

    await RouteMembership.findOneAndUpdate(
      { userId: req.user._id, routeId: route.routeId },
      { $set: { managerId: route.managerId, status: 'ACTIVE', grantedVia: 'PIN', grantedAt: new Date(), revokedAt: null } },
      { upsert: true, new: true }
    );

    return res.status(200).json({ success: true, data: { access: 'GRANTED', route: routeSummary(route) } });
  } catch (error) {
    next(error);
  }
};

// @desc    List PRIVATE routes the current user has ACTIVE membership on
// @route   GET /api/routes/my-private
exports.getMyPrivateRoutes = async (req, res, next) => {
  try {
    const memberships = await RouteMembership.find({ userId: req.user._id, status: 'ACTIVE' }).lean();
    const routeIds = memberships.map((m) => m.routeId);
    const routes = await Route.find({ routeId: { $in: routeIds }, isDeleted: false })
      .select('routeId routeName source destination distance estimatedTime fare serviceType stopsCount stops isActive joinApprovalRequired');

    return res.status(200).json({ success: true, count: routes.length, data: routes });
  } catch (error) {
    next(error);
  }
};

// @desc    List the current user's join requests
// @route   GET /api/routes/my-requests
exports.getMyJoinRequests = async (req, res, next) => {
  try {
    const filter = { userId: req.user._id };
    const status = String(req.query.status || '').toUpperCase();
    if (['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
      filter.status = status;
    }

    const requests = await RouteJoinRequest.find(filter).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ success: true, count: requests.length, data: requests });
  } catch (error) {
    next(error);
  }
};

// @desc    Leave a private route (revoke own membership)
// @route   DELETE /api/routes/:routeId/membership
exports.leavePrivateRoute = async (req, res, next) => {
  try {
    const membership = await RouteMembership.findOneAndUpdate(
      { userId: req.user._id, routeId: String(req.params.routeId).toUpperCase(), status: 'ACTIVE' },
      { $set: { status: 'REVOKED', revokedAt: new Date() } },
      { new: true }
    );
    if (!membership) {
      return res.status(404).json({ success: false, message: 'Active membership not found' });
    }
    return res.status(200).json({ success: true, message: 'Left route', data: membership });
  } catch (error) {
    next(error);
  }
};
