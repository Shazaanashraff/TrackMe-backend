// Manager-side endpoints for the Private Routes (room-key / PIN) feature.
// Every query is scoped to routes owned by the acting manager (route.managerId
// === req.user._id) — see PRIVATE_ROUTES_PLAN.md §5.1.
const Route = require('../models/Route');
const RouteMembership = require('../models/RouteMembership');
const RouteJoinRequest = require('../models/RouteJoinRequest');
const ManagerAuditLog = require('../models/ManagerAuditLog');
const { decryptCode, generateUniqueRoomKey } = require('../utils/roomKey');
const { createNotification } = require('../utils/notificationHelper');

const writeAuditLog = async ({ managerId, actorId, actorRole, action, entityType, entityId, metadata }) => {
  await ManagerAuditLog.create({ managerId, actorId, actorRole, action, entityType, entityId, metadata });
};

const findOwnedRoute = async (managerId, routeId) => {
  return Route.findOne({ routeId: String(routeId).toUpperCase(), managerId, isDeleted: false });
};

const roomKeyHashExists = async (hash) => {
  const existing = await Route.findOne({ 'roomKey.lookupHash': hash }).select('_id');
  return !!existing;
};

// @desc    List this manager's owned routes with privacy fields (never the plaintext code)
// @route   GET /api/manager/owned-routes
exports.getOwnedRoutes = async (req, res, next) => {
  try {
    const routes = await Route.find({ managerId: req.user._id, isDeleted: false })
      .select('routeId routeName source destination visibility isHidden joinApprovalRequired qrEnabled isActive status roomKey.updatedAt')
      .lean();

    const routeIds = routes.map((r) => r.routeId);
    const [memberCounts, pendingCounts] = await Promise.all([
      RouteMembership.aggregate([
        { $match: { routeId: { $in: routeIds }, status: 'ACTIVE' } },
        { $group: { _id: '$routeId', count: { $sum: 1 } } }
      ]),
      RouteJoinRequest.aggregate([
        { $match: { routeId: { $in: routeIds }, status: 'PENDING' } },
        { $group: { _id: '$routeId', count: { $sum: 1 } } }
      ])
    ]);
    const memberCountByRoute = Object.fromEntries(memberCounts.map((m) => [m._id, m.count]));
    const pendingCountByRoute = Object.fromEntries(pendingCounts.map((m) => [m._id, m.count]));

    const data = routes.map((route) => ({
      routeId: route.routeId,
      routeName: route.routeName,
      source: route.source,
      destination: route.destination,
      visibility: route.visibility,
      isHidden: route.isHidden,
      joinApprovalRequired: route.joinApprovalRequired,
      qrEnabled: route.qrEnabled,
      isActive: route.isActive,
      status: route.status,
      hasRoomKey: !!route.roomKey?.updatedAt,
      roomKeyUpdatedAt: route.roomKey?.updatedAt || null,
      memberCount: memberCountByRoute[route.routeId] || 0,
      pendingRequestCount: pendingCountByRoute[route.routeId] || 0
    }));

    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    next(error);
  }
};

// @desc    Set visibility PRIVATE/PUBLIC + isHidden/joinApprovalRequired flags for an owned route
// @route   PATCH /api/manager/routes/:routeId/privacy
exports.updateRoutePrivacy = async (req, res, next) => {
  try {
    const route = await findOwnedRoute(req.user._id, req.params.routeId);
    if (!route) {
      return res.status(403).json({ success: false, message: 'Route not found or not owned by this manager' });
    }

    const { isPrivate, isHidden, joinApprovalRequired } = req.body || {};
    const wasPrivate = route.visibility === 'PRIVATE';
    const willBePrivate = isPrivate === undefined ? wasPrivate : !!isPrivate;

    route.visibility = willBePrivate ? 'PRIVATE' : 'PUBLIC';

    if (willBePrivate) {
      if (isHidden !== undefined) route.isHidden = !!isHidden;
      if (joinApprovalRequired !== undefined) route.joinApprovalRequired = !!joinApprovalRequired;

      // Flip PUBLIC -> PRIVATE (or PRIVATE with no key yet) auto-generates a key.
      if (!route.roomKey?.lookupHash) {
        const generated = await generateUniqueRoomKey(roomKeyHashExists);
        route.roomKey = {
          ciphertext: generated.ciphertext,
          iv: generated.iv,
          authTag: generated.authTag,
          lookupHash: generated.lookupHash,
          updatedAt: new Date(),
          updatedBy: req.user._id
        };
      }
    }
    // Flip to PUBLIC clears flags + room key via the pre-save hook on Route.

    await route.save();

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'ROUTE_PRIVACY_UPDATED',
      entityType: 'ROUTE',
      entityId: route.routeId,
      metadata: { visibility: route.visibility, isHidden: route.isHidden, joinApprovalRequired: route.joinApprovalRequired }
    });

    return res.status(200).json({
      success: true,
      message: 'Route privacy updated',
      data: {
        routeId: route.routeId,
        visibility: route.visibility,
        isHidden: route.isHidden,
        joinApprovalRequired: route.joinApprovalRequired,
        hasRoomKey: !!route.roomKey?.lookupHash
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Turn QR attendance scanning on/off for an owned route.
// @route   PATCH /api/manager/routes/:routeId/qr
exports.updateRouteQr = async (req, res, next) => {
  try {
    const route = await findOwnedRoute(req.user._id, req.params.routeId);
    if (!route) {
      return res.status(403).json({ success: false, message: 'Route not found or not owned by this manager' });
    }

    route.qrEnabled = !!(req.body || {}).qrEnabled;
    await route.save();

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'ROUTE_QR_UPDATED',
      entityType: 'ROUTE',
      entityId: route.routeId,
      metadata: { qrEnabled: route.qrEnabled }
    });

    return res.status(200).json({
      success: true,
      message: 'Route QR attendance updated',
      data: { routeId: route.routeId, qrEnabled: route.qrEnabled }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Rotate an owned PRIVATE route's room key. Returns the new plaintext once.
// @route   POST /api/manager/routes/:routeId/room-key/rotate
exports.rotateRoomKey = async (req, res, next) => {
  try {
    const route = await findOwnedRoute(req.user._id, req.params.routeId);
    if (!route) {
      return res.status(403).json({ success: false, message: 'Route not found or not owned by this manager' });
    }
    if (route.visibility !== 'PRIVATE') {
      return res.status(400).json({ success: false, message: 'Route must be PRIVATE to have a room key' });
    }

    const generated = await generateUniqueRoomKey(roomKeyHashExists);
    route.roomKey = {
      ciphertext: generated.ciphertext,
      iv: generated.iv,
      authTag: generated.authTag,
      lookupHash: generated.lookupHash,
      updatedAt: new Date(),
      updatedBy: req.user._id
    };
    await route.save();

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'ROOM_KEY_ROTATED',
      entityType: 'ROUTE',
      entityId: route.routeId
    });

    return res.status(200).json({ success: true, message: 'Room key rotated', data: { routeId: route.routeId, code: generated.code } });
  } catch (error) {
    next(error);
  }
};

// @desc    Reveal the decrypted room key for an owned PRIVATE route
// @route   GET /api/manager/routes/:routeId/room-key
exports.revealRoomKey = async (req, res, next) => {
  try {
    const route = await findOwnedRoute(req.user._id, req.params.routeId);
    if (!route) {
      return res.status(403).json({ success: false, message: 'Route not found or not owned by this manager' });
    }
    if (!route.roomKey?.ciphertext) {
      return res.status(404).json({ success: false, message: 'This route has no room key yet' });
    }

    const code = decryptCode(route.roomKey);

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'ROOM_KEY_REVEALED',
      entityType: 'ROUTE',
      entityId: route.routeId
    });

    return res.status(200).json({ success: true, data: { routeId: route.routeId, code } });
  } catch (error) {
    next(error);
  }
};

// @desc    List join requests for an owned route
// @route   GET /api/manager/routes/:routeId/join-requests?status=PENDING
exports.getRouteJoinRequests = async (req, res, next) => {
  try {
    const route = await findOwnedRoute(req.user._id, req.params.routeId);
    if (!route) {
      return res.status(403).json({ success: false, message: 'Route not found or not owned by this manager' });
    }

    const filter = { routeId: route.routeId, managerId: req.user._id };
    const status = String(req.query.status || '').toUpperCase();
    if (['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
      filter.status = status;
    }

    const requests = await RouteJoinRequest.find(filter)
      .populate('userId', 'name email')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, count: requests.length, data: requests });
  } catch (error) {
    next(error);
  }
};

// @desc    Approve or reject a pending join request for an owned route
// @route   PATCH /api/manager/join-requests/:id/decision
exports.decideJoinRequest = async (req, res, next) => {
  try {
    const decision = String(req.body?.decision || '').toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'decision must be APPROVED or REJECTED' });
    }

    const joinRequest = await RouteJoinRequest.findOne({ _id: req.params.id, managerId: req.user._id });
    if (!joinRequest) {
      return res.status(404).json({ success: false, message: 'Join request not found' });
    }

    // Idempotent: only transition from PENDING; a second decision is a no-op.
    if (joinRequest.status !== 'PENDING') {
      return res.status(200).json({ success: true, message: 'Already decided', data: joinRequest });
    }

    joinRequest.status = decision;
    joinRequest.decisionBy = req.user._id;
    joinRequest.decisionNote = req.body?.note || '';
    joinRequest.decidedAt = new Date();
    await joinRequest.save();

    if (decision === 'APPROVED') {
      await RouteMembership.findOneAndUpdate(
        { userId: joinRequest.userId, routeId: joinRequest.routeId },
        {
          $set: {
            managerId: req.user._id,
            status: 'ACTIVE',
            grantedVia: 'APPROVAL',
            grantedAt: new Date(),
            revokedAt: null
          }
        },
        { upsert: true, new: true }
      );
      await createNotification(
        joinRequest.userId,
        'ROUTE_ACCESS_APPROVED',
        'Route access approved',
        `Your request to join route ${joinRequest.routeId} was approved.`,
        { routeId: joinRequest.routeId }
      );
    } else {
      await createNotification(
        joinRequest.userId,
        'ROUTE_ACCESS_REJECTED',
        'Route access rejected',
        `Your request to join route ${joinRequest.routeId} was rejected.`,
        { routeId: joinRequest.routeId }
      );
    }

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: `ROUTE_JOIN_REQUEST_${decision}`,
      entityType: 'ROUTE_JOIN_REQUEST',
      entityId: joinRequest._id.toString(),
      metadata: { routeId: joinRequest.routeId, userId: joinRequest.userId.toString() }
    });

    return res.status(200).json({ success: true, message: `Request ${decision.toLowerCase()}`, data: joinRequest });
  } catch (error) {
    next(error);
  }
};

// @desc    List active members for an owned route
// @route   GET /api/manager/routes/:routeId/members?status=ACTIVE
exports.getRouteMembers = async (req, res, next) => {
  try {
    const route = await findOwnedRoute(req.user._id, req.params.routeId);
    if (!route) {
      return res.status(403).json({ success: false, message: 'Route not found or not owned by this manager' });
    }

    const status = String(req.query.status || 'ACTIVE').toUpperCase();
    const filter = { routeId: route.routeId };
    if (['ACTIVE', 'REVOKED'].includes(status)) {
      filter.status = status;
    }

    const members = await RouteMembership.find(filter)
      .populate('userId', 'name email')
      .sort({ grantedAt: -1 })
      .lean();

    return res.status(200).json({ success: true, count: members.length, data: members });
  } catch (error) {
    next(error);
  }
};

// @desc    Revoke a member's access to an owned route (and kick if actively tracking)
// @route   DELETE /api/manager/routes/:routeId/members/:userId
exports.revokeRouteMember = async (req, res, next) => {
  try {
    const route = await findOwnedRoute(req.user._id, req.params.routeId);
    if (!route) {
      return res.status(403).json({ success: false, message: 'Route not found or not owned by this manager' });
    }

    const membership = await RouteMembership.findOneAndUpdate(
      { routeId: route.routeId, userId: req.params.userId, status: 'ACTIVE' },
      { $set: { status: 'REVOKED', revokedAt: new Date() } },
      { new: true }
    );
    if (!membership) {
      return res.status(404).json({ success: false, message: 'Active membership not found' });
    }

    await createNotification(
      req.params.userId,
      'ROUTE_ACCESS_REVOKED',
      'Route access revoked',
      `Your access to route ${route.routeId} has been revoked.`,
      { routeId: route.routeId }
    );

    // Kick an actively-tracking revoked user off the route's live room immediately.
    const io = req.app.get('io');
    if (io) {
      io.to(`route:${route.routeId}`).emit('route:access-revoked', { routeId: route.routeId, userId: String(req.params.userId) });
    }

    await writeAuditLog({
      managerId: req.user._id,
      actorId: req.user._id,
      actorRole: 'admin',
      action: 'ROUTE_MEMBER_REVOKED',
      entityType: 'ROUTE_MEMBERSHIP',
      entityId: membership._id.toString(),
      metadata: { routeId: route.routeId, userId: String(req.params.userId) }
    });

    return res.status(200).json({ success: true, message: 'Member revoked', data: membership });
  } catch (error) {
    next(error);
  }
};
