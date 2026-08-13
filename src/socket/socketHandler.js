const jwt = require('jsonwebtoken');
const Route = require('../models/Route');
const User = require('../models/User');
const Vehicle = require('../models/Vehicle');
const DriverEnrollment = require('../models/DriverEnrollment');
const RiderProfile = require('../models/RiderProfile');
const { findHouseholdProfiles } = require('../utils/identityRegistry');

// Socket layer, reduced to what QR attendance needs.
//
// Live tracking used to live here (driver:start-tracking / driver:location /
// driver:stop-tracking, manager:join-vehicle, route:get-recent-locations) and was
// removed with the rest of that feature — it is being reimplemented differently.
// What remains is the transport QR attendance depends on: an authenticated
// connection, a per-rider `student:<userId>` room, and `route:<routeId>` rooms,
// which boardingController emits `attendance:event` into.

const SOCKET_DEBUG = process.env.SOCKET_DEBUG === '1';
const debugLog = (...args) => {
  if (SOCKET_DEBUG) console.log(...args);
};

const setupSocket = (io) => {
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;

    if (!token) {
      console.error('❌ Socket auth failed: Missing token');
      return next(new Error('Missing authentication token'));
    }

    try {
      debugLog('🔐 Verifying token with JWT_SECRET length:', process.env.JWT_SECRET?.length || 0);
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      debugLog('✅ Token verified. User ID:', decoded.id);
      socket.userId = decoded.id;
      socket.userRole = decoded.role;
      next();
    } catch (error) {
      console.error('❌ Token verification failed:', error.message);
      next(new Error(`Invalid token: ${error.message}`));
    }
  });

  io.on('connection', async (socket) => {
    debugLog(`✅ Client connected: ${socket.id} (User: ${socket.userId})`);

    try {
      socket.data = {
        userId: socket.userId,
        userRole: socket.userRole,
        connectedAt: new Date(),
        activeRoute: null
      };

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
