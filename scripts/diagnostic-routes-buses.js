const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Route = require('../src/models/Route');
const Bus = require('../src/models/Bus');

dotenv.config();

const runDiagnostic = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/bus-tracking');
    console.log('📊 DIAGNOSTIC: Routes & Buses\n');

    // Get all active routes
    const routes = await Route.find({ isDeleted: false, isActive: true })
      .sort({ routeId: 1 })
      .lean();

    console.log(`✅ Found ${routes.length} active routes:`);
    routes.forEach(r => {
      console.log(`  - ${r.routeId}: ${r.routeName} (${r.serviceType}) [${r.source} → ${r.destination}]`);
    });

    console.log('\n');

    // For each route, count buses
    for (const route of routes) {
      const totalBuses = await Bus.countDocuments({ routeId: route.routeId, isDeleted: false });
      const activeBuses = await Bus.countDocuments({ routeId: route.routeId, isActive: true, isDeleted: false });
      
      console.log(`Route: ${route.routeId}`);
      console.log(`  Total buses: ${totalBuses}`);
      console.log(`  Active buses: ${activeBuses}`);
      
      if (totalBuses > 0) {
        const buses = await Bus.find({ routeId: route.routeId, isDeleted: false })
          .select('busId busName isActive serviceType')
          .sort({ busId: 1 });
        
        buses.forEach(bus => {
          const status = bus.isActive ? '✅ ACTIVE' : '⛔ INACTIVE';
          console.log(`    - ${bus.busId} (${bus.busName}) ${status}`);
        });
      }
      console.log('');
    }

    // Check if any buses have missing routeId
    const busesWithoutRoute = await Bus.countDocuments({ 
      $or: [
        { routeId: null },
        { routeId: { $exists: false } },
        { routeId: '' }
      ],
      isDeleted: false 
    });

    if (busesWithoutRoute > 0) {
      console.log(`⚠️  WARNING: ${busesWithoutRoute} buses have missing or empty routeId`);
    }

    await mongoose.connection.close();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
};

runDiagnostic();
