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

// Connect to MongoDB and bootstrap required auth accounts.
const bootstrap = async () => {
  await connectDB();
  await ensureSuperAdminAccount();
};

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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
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

// Start server
const PORT = process.env.PORT || 5000;
const startServer = async () => {
  try {
    await bootstrap();
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`WebSocket server ready`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Server bootstrap failed:', error.message);
    process.exit(1);
  }
};

startServer();

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
  process.exit(1);
});
