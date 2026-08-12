/**
 * Migration Script: Add serviceType and bookingEnabled fields
 * 
 * This script adds backward-compatible defaults to existing Route, Vehicle, and Booking documents:
 * - Routes without serviceType default to 'PUBLIC'
 * - Vehicles without serviceType default to 'PUBLIC' and bookingEnabled defaults to true
 * - Bookings without serviceType default to 'PUBLIC'
 * 
 * Run with: node scripts/migrate-service-types.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Route = require('../src/models/Route');
const Vehicle = require('../src/models/Vehicle');
const Booking = require('../src/models/Booking');

const MONGO_URI = process.env.MONGOURI;

const migrate = async () => {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected');

    // Migrate Routes
    console.log('\n📍 Migrating Routes...');
    const routesResult = await Route.updateMany(
      { serviceType: { $exists: false } },
      { $set: { serviceType: 'PUBLIC' } }
    );
    console.log(`   Updated ${routesResult.modifiedCount} routes with default serviceType='PUBLIC'`);

    // Migrate Vehicles
    console.log('\n🚌 Migrating Vehicles...');
    const vehiclesResult = await Vehicle.updateMany(
      { serviceType: { $exists: false } },
      {
        $set: {
          serviceType: 'PUBLIC',
          bookingEnabled: true
        }
      }
    );
    console.log(`   Updated ${vehiclesResult.modifiedCount} vehicles with serviceType='PUBLIC' and bookingEnabled=true`);

    // Migrate Bookings
    console.log('\n🎟️  Migrating Bookings...');
    const bookingsResult = await Booking.updateMany(
      { serviceType: { $exists: false } },
      { $set: { serviceType: 'PUBLIC' } }
    );
    console.log(`   Updated ${bookingsResult.modifiedCount} bookings with default serviceType='PUBLIC'`);

    // Verification
    console.log('\n✅ Verifying migration...');
    const routesCount = await Route.countDocuments({ serviceType: { $exists: false } });
    const vehiclesCount = await Vehicle.countDocuments({ serviceType: { $exists: false } });
    const bookingsCount = await Booking.countDocuments({ serviceType: { $exists: false } });

    if (routesCount === 0 && vehiclesCount === 0 && bookingsCount === 0) {
      console.log('   ✅ All records migrated successfully!');
      console.log('\n📊 Summary:');
      console.log(`   • ${routesResult.modifiedCount} routes updated`);
      console.log(`   • ${vehiclesResult.modifiedCount} vehicles updated`);
      console.log(`   • ${bookingsResult.modifiedCount} bookings updated`);
    } else {
      console.warn('   ⚠️  Some records were not migrated:');
      if (routesCount > 0) console.warn(`   • ${routesCount} routes still missing serviceType`);
      if (vehiclesCount > 0) console.warn(`   • ${vehiclesCount} vehicles still missing serviceType/bookingEnabled`);
      if (bookingsCount > 0) console.warn(`   • ${bookingsCount} bookings still missing serviceType`);
    }

    console.log('\n🎉 Migration completed!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
};

migrate();
