require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const connectDB = require('./config/db');
const setupSocket = require('./socket/socketHandler');
const { errorHandler } = require('./middleware/errorHandler');
const ensureSuperAdminAccount = require('./utils/ensureSuperAdminAccount');

// Route imports
const authRoutes = require('./routes/authRoutes');
const busRoutes = require('./routes/busRoutes');
const routeRoutes = require('./routes/routeRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const etaRoutes = require('./routes/etaRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const driverEarningsRoutes = require('./routes/driverEarningsRoutes');
const superAdminRoutes = require('./routes/superAdminRoutes');
const managerRoutes = require('./routes/managerRoutes');
const busReviewRoutes = require('./routes/busReviewRoutes');
const placesRoutes = require('./routes/placesRoutes');
const transitRoutes = require('./routes/transitRoutes');
const customRouteRoutes = require('./routes/customRouteRoutes');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGINS || '*',
    methods: ['GET', 'POST']
  }
});

// Startup state tracking for non-blocking initialization
const startupState = {
  httpReady: false,
  dbConnected: false,
  bootstrapComplete: false,
  startTime: Date.now()
};

// Connect to MongoDB and bootstrap required auth accounts (runs in background).
const bootstrap = async () => {
  try {
    console.log(`⏱️  [${new Date().toISOString()}] Starting DB connection...`);
    await connectDB();
    startupState.dbConnected = true;
    console.log(`✅ [${new Date().toISOString()}] DB connected (${Date.now() - startupState.startTime}ms)`);

    console.log(`⏱️  [${new Date().toISOString()}] Ensuring super admin account...`);
    await ensureSuperAdminAccount();
    startupState.bootstrapComplete = true;
    console.log(`✅ [${new Date().toISOString()}] Bootstrap complete (${Date.now() - startupState.startTime}ms)`);
  } catch (error) {
    console.error('❌ Bootstrap failed:', error.message);
    console.error('⚠️  Server will continue running, but DB-dependent features may fail');
  }
};

// Exposed so route handlers (e.g. revoking a private-route member) can emit
// socket events without importing the io instance directly.
app.set('io', io);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/bus', busRoutes);
app.use('/api/routes', routeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/eta', etaRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/driver-earnings', driverEarningsRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/manager', managerRoutes);
app.use('/api/bus-reviews', busReviewRoutes);
app.use('/api/places', placesRoutes);
app.use('/api/transit', transitRoutes);
app.use('/api/driver/custom-routes', customRouteRoutes);

// Health check endpoint (services receiving requests = keep-alive friendly)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    isReady: startupState.bootstrapComplete
  });
});

// Readiness check endpoint (all services ready including DB)
app.get('/ready', (req, res) => {
  if (startupState.bootstrapComplete) {
    return res.status(200).json({
      status: 'ready',
      message: 'All services initialized',
      timestamp: new Date().toISOString(),
      startupTimeMs: Date.now() - startupState.startTime
    });
  }
  
  res.status(202).json({
    status: 'starting',
    message: 'Services are initializing',
    dbConnected: startupState.dbConnected,
    bootstrapComplete: startupState.bootstrapComplete,
    uptime: process.uptime()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Setup Socket.IO
setupSocket(io);

// Centralized error handling middleware (must be last)
app.use(errorHandler);

// Start server - HTTP server listens immediately, bootstrap runs in background
const PORT = process.env.PORT || 5000;
const startServer = () => {
  try {
    const httpStartTime = Date.now();
    server.listen(PORT, () => {
      startupState.httpReady = true;
      const httpStartupTime = Date.now() - httpStartTime;
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`✅ HTTP Server listening on port ${PORT} (${httpStartupTime}ms)`);
      console.log(`🔌 Socket.IO server ready`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`⏱️  Startup timestamp: ${new Date().toISOString()}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      console.log(`⏱️  Bootstrap running in background...\n`);
    });

    // Start bootstrap in the background (non-blocking)
    bootstrap();
  } catch (error) {
    console.error('❌ Server startup failed:', error.message);
    process.exit(1);
  }
};

// Only start listening when run directly (node src/server.js).
// When imported by tests (require('../../src/server')), export the app/server
// instead so supertest can drive it without spawning a real listener.
if (require.main === module) {
  startServer();

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
    process.exit(1);
  });
}

module.exports = app;
module.exports.app = app;
module.exports.server = server;
module.exports.startServer = startServer;
