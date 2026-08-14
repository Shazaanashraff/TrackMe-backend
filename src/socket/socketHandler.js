const jwt = require('jsonwebtoken');
const Route = require('../models/Route');
const User = require('../models/User');
const Vehicle = require('../models/Vehicle');
const DriverEnrollment = require('../models/DriverEnrollment');
const RiderProfile = require('../models/RiderProfile');
const { findHouseholdProfiles } = require('../utils/identityRegistry');
const { findAccountById } = require('../utils/accountRegistry');
const { registerLiveTracking } = require('./liveTracking');
const liveVehicles = require('../utils/liveVehicles');

// The socket layer carries two features.
//
// QR attendance: an authenticated connection, a per-rider `student:<id>` room and
// `route:<routeId>` rooms, which boardingController emits `attendance:event` into.
//
// Live vehicle location: `vehicle:<vehicleId>` rooms, implemented in
// ./liveTracking.js and registered per connection below. It is kept in its own
// module because it owns session state and a rate limiter, and mixing that in
// here is what made the previous version 595 lines.

const SOCKET_DEBUG = process.env.SOCKET_DEBUG === '1';
const debugLog = (...args) => {
  if (SOCKET_DEBUG) console.log(...args);
};

const setupSocket = (io) => {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;

    if (!token) {
      console.error('❌ Socket auth failed: Missing token');
      return next(new Error('Missing authentication token'));
    }

    try {
      debugLog('🔐 Verifying token with JWT_SECRET length:', process.env.JWT_SECRET?.length || 0);
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

      // A refresh token verifies exactly like an access token, so without this
      // check it authenticates a socket for its full 7-day life. Only an
      // explicit 'refresh' is rejected: tokens minted before tokenType existed
      // carry no claim and must keep working.
      if (decoded.tokenType === 'refresh') {
        return next(new Error('Invalid token: refresh tokens cannot open a socket'));
      }

      // REST's `protect` loads the account and honours isActive; the socket
      // layer used to trust the claims alone, so a deactivated or deleted
      // account kept a working connection until its token expired. One lookup
      // per connection, not per message.
      const account = await findAccountById(decoded.id, decoded.role, { select: 'isActive' });
      if (!account?.doc) {
        return next(new Error('Invalid token: account not found'));
      }
      if (account.doc.isActive === false) {
        return next(new Error('Invalid token: account is deactivated'));
      }

      debugLog('✅ Token verified. User ID:', decoded.id);
      socket.userId = decoded.id;
      socket.userRole = decoded.role;
      next();
    } catch (error) {
      console.error('❌ Token verification failed:', error.message);
      next(new Error(`Invalid token: ${error.message}`));
    }
  });

  // One sweeper per server, not per connection: recovers vehicles left live by a
  // process that died without running its disconnect handlers.
  liveVehicles.startSweeper(async (vehicleId) => {
    io.to(`vehicle:${vehicleId}`).emit('vehicle:status', {
      vehicleId,
      live: false,
      reason: 'STALE_TIMEOUT',
      at: new Date().toISOString()
    });
  });

  io.on('connection', async (socket) => {
    debugLog(`✅ Client connected: ${socket.id} (User: ${socket.userId})`);

    // Register message handlers synchronously. A client can emit as soon as
    // its transport reports `connect`; waiting for the household lookups below
    // silently drops an immediate vehicle:subscribe before its listener exists.
    socket.data = {
      userId: socket.userId,
      userRole: socket.userRole,
      connectedAt: new Date(),
      activeRoute: null
    };
    registerLiveTracking(io, socket);

    try {

      // Every authenticated rider auto-joins a notification room per profile in
      // their household, not just their own connected one — an attendance event
      // for a managed profile must still reach the connection while a different
      // profile's session happens to be the one active. Only role 'user' has a
      // household concept; every other role keeps the original single-room join.
      if (socket.userRole === 'user') {
        const self = await User.findById(socket.userId).select('identityId').lean();
        const household = self?.identityId ? await findHouseholdProfiles(self.identityId) : null;

        if (household?.length) {
          for (const profile of household) {
            socket.join(`student:${profile._id}`);
          }
        } else {
          socket.join(`student:${socket.userId}`);
        }
      } else {
        socket.join(`student:${socket.userId}`);
      }

      socket.emit('connection-success', {
        socketId: socket.id,
        message: 'Connected',
        role: socket.userRole
      });
    } catch (error) {
      console.error('Error on connection:', error);
    }

    // Join a route room to receive that route's attendance events.
    socket.on('join-route', async (data, callback) => {
      try {
        const { routeId } = data || {};
        const riderId = data?.riderId || data?.studentId;

        if (!routeId || typeof routeId !== 'string') {
          return callback?.({ success: false, error: 'Valid Route ID is required' });
        }

        const route = await Route.findOne({ routeId, isDeleted: false }).select('_id');
        if (!route) {
          return callback?.({ success: false, error: 'Route not found' });
        }

        if (socket.userRole === 'user') {
          const student = await RiderProfile.exists({
            _id: riderId,
            accountId: socket.userId,
            isActive: { $ne: false }
          });
          if (!student) return callback?.({ success: false, error: 'Rider not found' });
          const driverIds = await Vehicle.find({ routeId, isDeleted: false }).distinct('driverId');
          const enrolled = await DriverEnrollment.exists({
            studentId: riderId,
            driverId: { $in: driverIds.filter(Boolean) },
            status: 'ACTIVE'
          });
          if (!enrolled) return callback?.({ success: false, error: 'Rider is not enrolled on this route' });
        }

        socket.join(`route:${routeId}`);
        socket.data.activeRoute = routeId;

        socket.emit('route-joined', { routeId });
        return callback?.({ success: true, routeId });
      } catch (error) {
        console.error('Error joining route:', error);
        return callback?.({ success: false, error: 'Failed to join route' });
      }
    });

    socket.on('leave-route', (data, callback) => {
      try {
        const { routeId } = data || {};
        if (!routeId) {
          return callback?.({ success: false, error: 'Route ID is required' });
        }

        socket.leave(`route:${routeId}`);
        if (socket.data?.activeRoute === routeId) {
          socket.data.activeRoute = null;
        }

        return callback?.({ success: true, routeId });
      } catch (error) {
        console.error('Error leaving route:', error);
        return callback?.({ success: false, error: 'Failed to leave route' });
      }
    });

    socket.on('disconnect', () => {
      debugLog(`👋 Client disconnected: ${socket.id}`);
    });

    socket.on('error', (error) => {
      console.error(`Socket error (${socket.id}):`, error);
    });
  });
};

module.exports = setupSocket;
