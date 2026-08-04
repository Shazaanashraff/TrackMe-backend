const LiveLocation = require('../models/LiveLocation');
const Vehicle = require('../models/Vehicle');
const Route = require('../models/Route');
const RouteMembership = require('../models/RouteMembership');
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
// stdout (and stalling the event loop) when many vehicles stream locations.
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
      socket.userRole = decoded.role;
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
      // Store connection metadata (role already decoded from the JWT in io.use)
      socket.data = {
        userId: socket.userId,
        userRole: socket.userRole,
        connectedAt: new Date(),
        activeRoute: null,
        activeVehicle: null
      };

      // Every authenticated rider auto-joins their own notification room so
      // server-side emits targeted at `student:<userId>` (QR attendance status
      // flips, private-route access-revoked, etc.) always have a listener.
      socket.join(`student:${socket.userId}`);

      socket.emit('connection-success', {
        socketId: socket.id,
        message: 'Connected to vehicle tracking server',
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

        const { vehicleId } = data;

        if (!vehicleId || typeof vehicleId !== 'string') {
          return callback?.({ 
            success: false, 
            error: 'Valid Vehicle ID is required' 
          });
        }

        // Verify vehicle exists and belongs to this driver
        const vehicle = await Vehicle.findOne({ vehicleId, driverId: socket.userId, isDeleted: false });
        if (!vehicle) {
          return callback?.({ 
            success: false, 
            error: 'Vehicle not found or not assigned to you' 
          });
        }

        // Update vehicle status
        const updatedVehicle = await Vehicle.findOneAndUpdate(
          { vehicleId },
          { isActive: true },
          { new: true }
        );

        // Store active session
        activeSessions.set(vehicleId, {
          socketId: socket.id,
          userId: socket.userId,
          startTime: new Date(),
          route: vehicle.routeId
        });

        socket.data.activeVehicle = vehicleId;
        socket.data.activeRoute = vehicle.routeId;

        // Join route room for broadcasting
        socket.join(`route:${vehicle.routeId}`);
        socket.join(`vehicle:${vehicleId}`);
        socket.join(`driver:${vehicleId}`);

        console.log(`✅ Driver started tracking: Vehicle ${vehicleId}`);

        callback?.({ 
          success: true, 
          message: 'Tracking started',
          vehicle: {
            vehicleId: updatedVehicle.vehicleId,
            vehicleName: updatedVehicle.vehicleName,
            routeId: updatedVehicle.routeId,
            serviceType: updatedVehicle.serviceType,
            bookingEnabled: updatedVehicle.bookingEnabled
          }
        });

        // Notify users on the route
        io.to(`route:${vehicle.routeId}`).emit('vehicle:status-update', {
          vehicleId,
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

        const { vehicleId, routeId, lat, lng, accuracy, speed } = data;
        debugLog(`📍 driver:location received: vehicle=${vehicleId}, lat=${lat}, lng=${lng}`);
        
        const parsedLat = Number(lat);
        const parsedLng = Number(lng);

        // Validate input data
        if (!vehicleId || lat === undefined || lng === undefined) {
          console.log('❌ Missing required fields');
          return callback?.({ 
            success: false,
            error: 'Missing required fields: vehicleId, lat, lng'
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

        // Verify vehicle exists and is owned by this driver
        const vehicle = await Vehicle.findOne({ 
          vehicleId, 
          driverId: socket.userId, 
          isDeleted: false 
        });

        if (!vehicle) {
          console.log(`❌ Vehicle not found or not owned by driver: ${vehicleId}`);
          return callback?.({ 
            success: false,
            error: 'Vehicle not found or unauthorized' 
          });
        }

        const effectiveRouteInput = String(routeId || vehicle.routeId || '').trim();
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
          vehicleId,
          routeId: route.routeId,
          lat: parsedLat,
          lng: parsedLng,
          accuracy: accuracy || null,
          speed: speed || null,
          timestamp: new Date()
        });
        
        debugLog(`✅ Location saved for vehicle ${vehicleId}`);

        // Ensure vehicle is marked as active
        if (!vehicle.isActive) {
          await Vehicle.findOneAndUpdate(
            { vehicleId },
            { isActive: true }
          );
          debugLog(`✅ Marked vehicle ${vehicleId} as active`);
        }

        // Prepare broadcast payload
        const updatePayload = {
          vehicleId,
          vehicleName: vehicle.vehicleName,
          routeId: route.routeId,
          serviceType: vehicle.serviceType || 'PUBLIC',
          bookingEnabled: vehicle.bookingEnabled,
          lat: parsedLat,
          lng: parsedLng,
          accuracy: accuracy || null,
          speed: speed || null,
          timestamp: new Date().toISOString(),
          driverId: socket.userId
        };

        // Broadcast to all users watching this route and vehicle-specific subscribers.
        io.to(`route:${route.routeId}`).emit('vehicle:update', updatePayload);
        io.to(`vehicle:${vehicleId}`).emit('vehicle:update', updatePayload);

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
        const { vehicleId } = data;

        if (!vehicleId || typeof vehicleId !== 'string') {
          return callback?.({ 
            success: false,
            error: 'Valid Vehicle ID is required' 
          });
        }

        // Verify vehicle ownership
        const vehicle = await Vehicle.findOne({ 
          vehicleId, 
          driverId: socket.userId, 
          isDeleted: false 
        });

        if (!vehicle) {
          return callback?.({ 
            success: false,
            error: 'Vehicle not found or unauthorized' 
          });
        }

        // Update vehicle status
        const updatedVehicle = await Vehicle.findOneAndUpdate(
          { vehicleId },
          { isActive: false },
          { new: true }
        );

        // Remove from active sessions
        if (activeSessions.has(vehicleId)) {
          const session = activeSessions.get(vehicleId);
          const duration = Date.now() - session.startTime.getTime();
          console.log(`✅ Driver completed session for Vehicle ${vehicleId} (Duration: ${duration}ms)`);
          activeSessions.delete(vehicleId);
        }

        socket.data.activeVehicle = null;

        // Leave rooms
        socket.leave(`driver:${vehicleId}`);
        if (vehicle.routeId) {
          socket.leave(`route:${vehicle.routeId}`);
        }

        console.log(`❌ Driver stopped tracking: Vehicle ${vehicleId}`);

        callback?.({ 
          success: true,
          message: 'Tracking stopped'
        });

        // Notify users on the route
        if (vehicle.routeId) {
          io.to(`route:${vehicle.routeId}`).emit('vehicle:status-update', {
            vehicleId,
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

    // Manager or super-admin joins a specific vehicle room for scoped live tracking.
    socket.on('manager:join-vehicle', async (data, callback) => {
      try {
        const { vehicleId } = data || {};
        if (!vehicleId || typeof vehicleId !== 'string') {
          return callback?.({ success: false, error: 'Valid Vehicle ID is required' });
        }

        if (!['admin', 'super-admin'].includes(socket.userRole)) {
          return callback?.({ success: false, error: 'Manager role required' });
        }

        const query = { vehicleId, isDeleted: false };
        if (socket.userRole === 'admin') {
          query.managerId = socket.userId;
        }

        const vehicle = await Vehicle.findOne(query).select('vehicleId routeId vehicleName');
        if (!vehicle) {
          return callback?.({ success: false, error: 'Vehicle not found for this manager' });
        }

        socket.join(`vehicle:${vehicle.vehicleId}`);
        socket.data.activeVehicle = vehicle.vehicleId;

        return callback?.({
          success: true,
          message: `Joined vehicle room ${vehicle.vehicleId}`,
          data: {
            vehicleId: vehicle.vehicleId,
            vehicleName: vehicle.vehicleName,
            routeId: vehicle.routeId
          }
        });
      } catch (error) {
        console.error('Error in manager:join-vehicle:', error);
        return callback?.({ success: false, error: error.message });
      }
    });

    socket.on('manager:leave-vehicle', (data, callback) => {
      try {
        const { vehicleId } = data || {};
        if (!vehicleId || typeof vehicleId !== 'string') {
          return callback?.({ success: false, error: 'Valid Vehicle ID is required' });
        }

        socket.leave(`vehicle:${vehicleId}`);
        if (socket.data.activeVehicle === vehicleId) {
          socket.data.activeVehicle = null;
        }

        return callback?.({ success: true, message: `Left vehicle room ${vehicleId}` });
      } catch (error) {
        console.error('Error in manager:leave-vehicle:', error);
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

        // Get the most recent location for each active vehicle on the route
        const activeVehiclesOnRoute = await Vehicle.find({
          routeId,
          isActive: true,
          isDeleted: false
        }).select('vehicleId vehicleName serviceType bookingEnabled');
        
        console.log(`📍 Found ${activeVehiclesOnRoute.length} active vehicles on route ${routeId}`);

        const locations = await Promise.all(
          activeVehiclesOnRoute.map(async (vehicle) => {
            const loc = await LiveLocation.findOne({ vehicleId: vehicle.vehicleId })
              .sort({ timestamp: -1 });
            debugLog(`📍 Vehicle ${vehicle.vehicleId}: location = ${loc ? 'found' : 'NOT found'}`);
            return {
              vehicleId: vehicle.vehicleId,
              vehicleName: vehicle.vehicleName,
              serviceType: vehicle.serviceType || 'PUBLIC',
              bookingEnabled: vehicle.bookingEnabled,
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
      for (const [vehicleId, session] of activeSessions.entries()) {
        if (session.socketId === socket.id) {
          await Vehicle.findOneAndUpdate(
            { vehicleId, isDeleted: false },
            { isActive: false }
          );

          if (session.route) {
            io.to(`route:${session.route}`).emit('vehicle:status-update', {
              vehicleId,
              status: 'TRACKING_STOPPED',
              timestamp: new Date().toISOString(),
              reason: 'DRIVER_DISCONNECTED'
            });
          }

          activeSessions.delete(vehicleId);
          console.log(`Cleaned up session for vehicle: ${vehicleId}`);
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
setupSocket.getActiveSessions = () => Array.from(activeSessions.entries()).map(([vehicleId, session]) => ({
  vehicleId,
  ...session
}));

module.exports = setupSocket;
