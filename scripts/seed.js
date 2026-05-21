require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Bus = require('../src/models/Bus');
const Route = require('../src/models/Route');

const seedData = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB Connected for seeding');

    // Clear existing data
    await User.deleteMany({});
    await Bus.deleteMany({});
    await Route.deleteMany({});
    console.log('Cleared existing data');

    // Create driver
    const driver = await User.create({
      name: 'Test Driver',
      email: 'driver@test.com',
      password: 'password123',
      role: 'driver',
      isEmailVerified: true
    });
    console.log('Created driver:', driver.email);

    // Create regular user
    const user = await User.create({
      name: 'Test User',
      email: 'user@test.com',
      password: 'password123',
      role: 'user',
      isEmailVerified: true
    });
    console.log('Created user:', user.email);

    // Create admin
    const admin = await User.create({
      name: 'Platform Admin',
      email: 'admin@test.com',
      password: 'password123',
      role: 'admin',
      isEmailVerified: true
    });
    console.log('Created admin:', admin.email);

    // Create super-admin
    const superAdmin = await User.create({
      name: 'Platform Super Admin',
      email: 'superadmin@test.com',
      password: 'password123',
      role: 'super-admin',
      isEmailVerified: true
    });
    console.log('Created super-admin:', superAdmin.email);
    
    // Create routes
    const routes = await Route.insertMany([
      {
        routeId: 'ROUTE_A',
        routeName: 'Main Street - City Center',
        source: 'Suburb A',
        destination: 'City Center',
        distance: 12.5,
        fare: 50,
        serviceType: 'PUBLIC',
        stops: [
          { stopName: 'Stop 1', order: 1, lat: 28.6139, lng: 77.2090 },
          { stopName: 'Stop 2', order: 2, lat: 28.6239, lng: 77.2190 }
        ]
      },
      {
        routeId: 'ROUTE_B',
        routeName: 'Expressway Shuttle',
        source: 'Business Park',
        destination: 'Metro Station',
        distance: 8.2,
        fare: 35,
        serviceType: 'OFFICE',
        stops: [
          { stopName: 'Stop 1', order: 1, lat: 28.6339, lng: 77.2290 },
          { stopName: 'Stop 2', order: 2, lat: 28.6439, lng: 77.2390 }
        ]
      },
      {
        routeId: 'ROUTE_C',
        routeName: 'University Campus Loop',
        source: 'North Campus',
        destination: 'South Campus',
        distance: 5.4,
        fare: 20,
        serviceType: 'UNIVERSITY',
        stops: [
          { stopName: 'Stop 1', order: 1, lat: 28.6539, lng: 77.2490 },
          { stopName: 'Stop 2', order: 2, lat: 28.6639, lng: 77.2590 }
        ]
      }
    ]);
    console.log(`Created ${routes.length} routes`);

    // Create buses
    const buses = await Bus.insertMany([
      {
        busId: 'BUS001',
        busName: 'City Express 1',
        registrationNumber: 'MH-01-AB-1001',
        numberPlate: 'MH-01-AB-1001',
        routeId: 'ROUTE_A',
        driverId: driver._id,
        seatCapacity: 50,
        busType: 'AC'
      },
      {
        busId: 'BUS002',
        busName: 'Metro Shuttle 2',
        registrationNumber: 'MH-01-AB-1002',
        numberPlate: 'MH-01-AB-1002',
        routeId: 'ROUTE_B',
        driverId: driver._id,
        seatCapacity: 42,
        busType: 'NON-AC'
      },
      {
        busId: 'BUS003',
        busName: 'Downtown Connector',
        registrationNumber: 'MH-01-AB-1003',
        numberPlate: 'MH-01-AB-1003',
        routeId: 'ROUTE_C',
        driverId: driver._id,
        seatCapacity: 36,
        busType: 'DELUXE'
      }
    ]);
    console.log(`Created ${buses.length} buses`);

    console.log('\n--- Seed Complete ---');
    console.log('Driver login: driver@test.com / password123');
    console.log('User login: user@test.com / password123');
    console.log('Admin login: admin@test.com / password123');
    console.log('Super-admin login: superadmin@test.com / password123');
    console.log('Routes: ROUTE_A, ROUTE_B, ROUTE_C');

    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
};

seedData();
