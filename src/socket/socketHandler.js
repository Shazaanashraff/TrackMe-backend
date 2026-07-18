const LiveLocation = require('../models/LiveLocation');
const Bus = require('../models/Bus');
const Route = require('../models/Route');
const RouteMembership = require('../models/RouteMembership');
const User = require('../models/User');
const { createNotification } = require('../utils/notificationHelper');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

// Track active driver sessions
const activeSessions = new Map();

// Rate limiting helper
const rateLimit = (() => {
  const limits = new Map();
  
  return {
    check: (socketId, event, maxPerSecond = 10) => {
      const key = `${socketId}:${event}`;
      const now = Date.now();
      
      if (!limits.has(key)) {
        limits.set(key, []);
      }
      
      const times = limits.get(key);
      const filtered = times.filter(t => now - t < 1000);
      
      if (filtered.length >= maxPerSecond) {
        return false;
      }
      
      filtered.push(now);
      limits.set(key, filtered);
      return true;
    },
    
    cleanup: () => {
      const now = Date.now();
      for (const [key, times] of limits.entries()) {
        const filtered = times.filter(t => now - t < 1000);
        if (filtered.length === 0) {
          limits.delete(key);
        }
      }
    }
  };
})();

// Cleanup rate limits periodically
setInterval(() => rateLimit.cleanup(), 60000);

// High-frequency socket logging is gated behind SOCKET_DEBUG to avoid flooding
// stdout (and stalling the event loop) when many buses stream locations.
const debugLog = (...args) => { if (process.env.SOCKET_DEBUG) console.log(...args); };

const setupSocket = (io) => {
  // Socket.IO middleware for authentication
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    
    if (!token) {
      console.error('❌ Socket auth failed: Missing token');
      return next(new Error('Missing authentication token'));
    }

    try {
      debugLog('🔐 Verifying token with JWT_SECRET length:', process.env.JWT_SECRET?.length || 0);
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      debugLog('✅ Token verified. User ID:', decoded.id);
      socket.userId = decoded.id;
      next();
    } catch (error) {
      console.error('❌ Token verification failed:', error.message);
      console.error('   Token sample:', token?.substring(0, 50) + '...');
      console.error('   JWT_SECRET exists:', !!process.env.JWT_SECRET);
      next(new Error(`Invalid token: ${error.message}`));
    }
  });

  io.on('connection', async (socket) => {
    console.log(`✅ Client connected: ${socket.id} (User: ${socket.userId})`);

    try {
      // Get user info
      const user = await User.findById(socket.userId);
      socket.userRole = user?.role;
      
      // Store connection metadata
      socket.data = {
        userId: socket.userId,
        userRole: user?.role,
        connectedAt: new Date(),
        activeRoute: null,
        activeBus: null
      };

      socket.emit('connection-success', {
        socketId: socket.id,
        message: 'Connected to bus tracking server',
        role: socket.userRole
      });
    } catch (error) {
      console.error('Error on connection:', error);
    }

    // ==================== DRIVER EVENTS ====================

    // Driver starts tracking
    socket.on('driver:start-tracking', async (data, callback) => {
      try {
        // Rate limiting
        if (!rateLimit.check(socket.id, 'driver:start-tracking', 2)) {
          const err = new Error('Rate limit exceeded');
          return callback?.({ success: false, error: err.message });
        }

        const { busId } = data;

        if (!busId || typeof busId !== 'string') {
          return callback?.({ 
            success: false, 
            error: 'Valid Bus ID is required' 
          });
        }

        // Verify bus exists and belongs to this driver
        const bus = await Bus.findOne({ busId, driverId: socket.userId, isDeleted: false });
        if (!bus) {
          return callback?.({ 
            success: false, 
            error: 'Bus not found or not assigned to you' 
          });
        }

        // Update bus status
        const updatedBus = await Bus.findOneAndUpdate(
          { busId },
          { isActive: true },
          { new: true }
        );

        // Store active session
        activeSessions.set(busId, {
          socketId: socket.id,
          userId: socket.userId,
          startTime: new Date(),
          route: bus.routeId
        });

        socket.data.activeBus = busId;
        socket.data.activeRoute = bus.routeId;

        // Join route room for broadcasting
        socket.join(`route:${bus.routeId}`);
        socket.join(`bus:${busId}`);
        socket.join(`driver:${busId}`);

        console.log(`✅ Driver started tracking: Bus ${busId}`);

        callback?.({ 
          success: true, 
          message: 'Tracking started',
          bus: {
            busId: updatedBus.busId,
            busName: updatedBus.busName,
            routeId: updatedBus.routeId,
            serviceType: updatedBus.serviceType,
            bookingEnabled: updatedBus.bookingEnabled
          }
        });

        // Notify users on the route
        io.to(`route:${bus.routeId}`).emit('bus:status-update', {
          busId,
          status: 'TRACKING_STARTED',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error starting tracking:', error);
        callback?.({ 
          success: false, 
          error: error.message 
        });
      }
    });

    // Driver sends location update
    socket.on('driver:location', async (data, callback) => {
      try {
        // Rate limiting - allow max 10 updates per second
        if (!rateLimit.check(socket.id, 'driver:location', 10)) {
          return callback?.({ 
            success: false, 
            error: 'Too many location updates' 
          });
        }

        const { busId, routeId, lat, lng, accuracy, speed } = data;
        debugLog(`📍 driver:location received: bus=${busId}, lat=${lat}, lng=${lng}`);
        
        const parsedLat = Number(lat);
        const parsedLng = Number(lng);

        // Validate input data
        if (!busId || lat === undefined || lng === undefined) {
          console.log('❌ Missing required fields');
          return callback?.({ 
            success: false,
            error: 'Missing required fields: busId, lat, lng'
          });
        }

        // Validate latitude and longitude ranges
        if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng) || parsedLat < -90 || parsedLat > 90 || parsedLng < -180 || parsedLng > 180) {
          console.log('❌ Invalid coordinates');
          return callback?.({ 
            success: false,
            error: 'Invalid coordinates' 
          });
        }

        // Verify bus exists and is owned by this driver
        const bus = await Bus.findOne({ 
          busId, 
          driverId: socket.userId, 
          isDeleted: false 
        });

        if (!bus) {
          console.log(`❌ Bus not found or not owned by driver: ${busId}`);
          return callback?.({ 
            success: false,
            error: 'Bus not found or unauthorized' 
          });
        }

        const effectiveRouteInput = String(routeId || bus.routeId || '').trim();
        const routeLookup = [{ routeId: effectiveRouteInput }];
        if (mongoose.Types.ObjectId.isValid(effectiveRouteInput)) {
          routeLookup.push({ _id: effectiveRouteInput });
        }

        // Verify route exists. Accept either business routeId or Mongo ObjectId to support legacy data.
        const route = await Route.findOne({
          $or: routeLookup,
          isDeleted: false
        });

        if (!route) {
          console.log(`❌ Invalid route: ${effectiveRouteInput}`);
          return callback?.({ 
            success: false,
            error: 'Invalid route' 
          });
        }

        // Save location to database
        const liveLocation = await LiveLocation.create({
          busId,
          routeId: route.routeId,
          lat: parsedLat,
          lng: parsedLng,
          accuracy: accuracy || null,
          speed: speed || null,
          timestamp: new Date()
        });
        
        debugLog(`✅ Location saved for bus ${busId}`);

        // Ensure bus is marked as active
        if (!bus.isActive) {
          await Bus.findOneAndUpdate(
            { busId },
            { isActive: true }
          );
          debugLog(`✅ Marked bus ${busId} as active`);
        }

        // Prepare broadcast payload
        const updatePayload = {
          busId,
          busName: bus.busName,
          routeId: route.routeId,
          serviceType: bus.serviceType || 'PUBLIC',
          bookingEnabled: bus.bookingEnabled,
          lat: parsedLat,
          lng: parsedLng,
          accuracy: accuracy || null,
          speed: speed || null,
          timestamp: new Date().toISOString(),
          driverId: socket.userId
        };

        // Broadcast to all users watching this route and bus-specific subscribers.
        io.to(`route:${route.routeId}`).emit('bus:update', updatePayload);
        io.to(`bus:${busId}`).emit('bus:update', updatePayload);

        callback?.({ 
          success: true, 
          message: 'Location updated',
          locationId: liveLocation._id
        });

      } catch (error) {
        console.error('Error processing location:', error);
        callback?.({ 
          success: false,
          error: error.message 
        });
      }
    });

    // Driver stops tracking
    socket.on('driver:stop-tracking', async (data, callback) => {
      try {
        const { busId } = data;

        if (!busId || typeof busId !== 'string') {
          return callback?.({ 
            success: false,
            error: 'Valid Bus ID is required' 
          });
        }

        // Verify bus ownership
        const bus = await Bus.findOne({ 
          busId, 
          driverId: socket.userId, 
          isDeleted: false 
        });

        if (!bus) {
          return callback?.({ 
            success: false,
            error: 'Bus not found or unauthorized' 
          });
        }

        // Update bus status
        const updatedBus = await Bus.findOneAndUpdate(
          { busId },
          { isActive: false },
          { new: true }
        );

        // Remove from active sessions
        if (activeSessions.has(busId)) {
          const session = activeSessions.get(busId);
          const duration = Date.now() - session.startTime.getTime();
          console.log(`✅ Driver completed session for Bus ${busId} (Duration: ${duration}ms)`);
          activeSessions.delete(busId);
        }

        socket.data.activeBus = null;

        // Leave rooms
        socket.leave(`driver:${busId}`);
        if (bus.routeId) {
          socket.leave(`route:${bus.routeId}`);
        }

        console.log(`❌ Driver stopped tracking: Bus ${busId}`);

        callback?.({ 
          success: true,
          message: 'Tracking stopped'
        });

        // Notify users on the route
        if (bus.routeId) {
          io.to(`route:${bus.routeId}`).emit('bus:status-update', {
            busId,
            status: 'TRACKING_STOPPED',
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        console.error('Error stopping tracking:', error);
        callback?.({ 
          success: false,
          error: error.message 
        });
      }
    });

    // ==================== USER/PASSENGER EVENTS ====================

    // Manager or super-admin joins a specific bus room for scoped live tracking.
    socket.on('manager:join-bus', async (data, callback) => {
      try {
        const { busId } = data || {};
        if (!busId || typeof busId !== 'string') {
          return callback?.({ success: false, error: 'Valid Bus ID is required' });
        }

        if (!['admin', 'super-admin'].includes(socket.userRole)) {
          return callback?.({ success: false, error: 'Manager role required' });
        }

        const query = { busId, isDeleted: false };
        if (socket.userRole === 'admin') {
          query.managerId = socket.userId;
        }

        const bus = await Bus.findOne(query).select('busId routeId busName');
        if (!bus) {
          return callback?.({ success: false, error: 'Bus not found for this manager' });
        }

        socket.join(`bus:${bus.busId}`);
        socket.data.activeBus = bus.busId;

        return callback?.({
          success: true,
          message: `Joined bus room ${bus.busId}`,
          data: {
            busId: bus.busId,
            busName: bus.busName,
            routeId: bus.routeId
          }
        });
      } catch (error) {
        console.error('Error in manager:join-bus:', error);
        return callback?.({ success: false, error: error.message });
      }
    });

    socket.on('manager:leave-bus', (data, callback) => {
      try {
        const { busId } = data || {};
        if (!busId || typeof busId !== 'string') {
          return callback?.({ success: false, error: 'Valid Bus ID is required' });
        }

        socket.leave(`bus:${busId}`);
        if (socket.data.activeBus === busId) {
          socket.data.activeBus = null;
        }

        return callback?.({ success: true, message: `Left bus room ${busId}` });
      } catch (error) {
        console.error('Error in manager:leave-bus:', error);
        return callback?.({ success: false, error: error.message });
      }
    });

    // User joins a route room to receive updates
    socket.on('join-route', async (data, callback) => {
      try {
        const { routeId } = data;

        if (!routeId || typeof routeId !== 'string') {
          return callback?.({
            success: false,
            error: 'Valid Route ID is required'
          });
        }

        // A PRIVATE route (manager custom shuttle, or a Private Routes feature
        // route) only joins here for an authenticated user with an ACTIVE
        // membership — see PRIVATE_ROUTES_PLAN.md §5.3.
        const route = await Route.findOne({ routeId, isDeleted: false }).select('visibility');
        if (route && route.visibility === 'PRIVATE') {
          const isMember = socket.userId && await RouteMembership.exists({
            userId: socket.userId,
            routeId,
            status: 'ACTIVE'
          });
          if (!isMember) {
            return callback?.({
              success: false,
              error: 'Access denied'
            });
          }
        }

        socket.join(`route:${routeId}`);
        socket.data.activeRoute = routeId;

        console.log(`👤 User ${socket.id} joined route: ${routeId}`);

        callback?.({ 
          success: true,
          message: `Successfully joined route ${routeId}`
        });

        // Optionally send recent locations for this route
        socket.emit('route-joined', { 
          routeId,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Error joining route:', error);
        callback?.({ 
          success: false,
          error: error.message 
        });
      }
    });

    // User leaves a route room
    socket.on('leave-route', (data, callback) => {
      try {
        const { routeId } = data;

        if (routeId) {
          socket.leave(`route:${routeId}`);
          socket.data.activeRoute = null;
          console.log(`👤 User ${socket.id} left route: ${routeId}`);
          
          callback?.({ 
            success: true,
            message: `Left route ${routeId}`
          });
        }
      } catch (error) {
        console.error('Error leaving route:', error);
        callback?.({ 
          success: false,
          error: error.message 
        });
      }
    });

    // Request recent locations for a route
    socket.on('route:get-recent-locations', async (data, callback) => {
      try {
        const { routeId, limit = 10 } = data;
        console.log('📡 route:get-recent-locations received for route:', routeId);

        if (!routeId) {
          console.log('❌ No routeId provided');
          return callback?.({
            success: false,
            error: 'Route ID is required'
          });
        }

        // A PRIVATE route only leaks live locations to an authenticated member.
        const route = await Route.findOne({ routeId, isDeleted: false }).select('visibility');
        if (route && route.visibility === 'PRIVATE') {
          const isMember = socket.userId && await RouteMembership.exists({
            userId: socket.userId,
            routeId,
            status: 'ACTIVE'
          });
          if (!isMember) {
            return callback?.({ success: false, error: 'Access denied' });
          }
        }

        // Get the most recent location for each active bus on the route
        const activeBusesOnRoute = await Bus.find({
          routeId,
          isActive: true,
          isDeleted: false
        }).select('busId busName serviceType bookingEnabled');
        
        console.log(`📍 Found ${activeBusesOnRoute.length} active buses on route ${routeId}`);

        const locations = await Promise.all(
          activeBusesOnRoute.map(async (bus) => {
            const loc = await LiveLocation.findOne({ busId: bus.busId })
              .sort({ timestamp: -1 });
            debugLog(`📍 Bus ${bus.busId}: location = ${loc ? 'found' : 'NOT found'}`);
            return {
              busId: bus.busId,
              busName: bus.busName,
              serviceType: bus.serviceType || 'PUBLIC',
              bookingEnabled: bus.bookingEnabled,
              location: loc ? { lat: loc.lat, lng: loc.lng } : null,
              lastUpdate: loc?.timestamp
            };
          })
        );

        console.log(`✅ Returning ${locations.length} location records`);
        callback?.({ 
          success: true,
          data: locations
        });
      } catch (error) {
        console.error('Error getting recent locations:', error);
        callback?.({ 
          success: false,
          error: error.message 
        });
      }
    });

    // ==================== DISCONNECTION & ERROR HANDLING ====================

    socket.on('disconnect', async () => {
      console.log(`👋 Client disconnected: ${socket.id}`);

      // Clean up active sessions if this was a driver
      for (const [busId, session] of activeSessions.entries()) {
        if (session.socketId === socket.id) {
          await Bus.findOneAndUpdate(
            { busId, isDeleted: false },
            { isActive: false }
          );

          if (session.route) {
            io.to(`route:${session.route}`).emit('bus:status-update', {
              busId,
              status: 'TRACKING_STOPPED',
              timestamp: new Date().toISOString(),
              reason: 'DRIVER_DISCONNECTED'
            });
          }

          activeSessions.delete(busId);
          console.log(`Cleaned up session for bus: ${busId}`);
        }
      }
    });

    socket.on('error', (error) => {
      console.error(`Socket error (${socket.id}):`, error);
    });
  });

  // Periodic health check of active sessions
  setInterval(() => {
    console.log(`📊 Active sessions: ${activeSessions.size}`);
  }, 30000);
};

// Export for monitoring
setupSocket.getActiveSessions = () => Array.from(activeSessions.entries()).map(([busId, session]) => ({
  busId,
  ...session
}));

module.exports = setupSocket;
