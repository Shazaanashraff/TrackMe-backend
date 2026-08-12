const mongoose = require('mongoose');
const Vehicle = require('../src/models/Vehicle');
const Driver = require('../src/models/Driver');
const dotenv = require('dotenv');

dotenv.config();

// Test driver data - we'll create these first
const TEST_DRIVERS = [
  { email: 'driver.slt100@vehicle.com', name: 'Drivers Team 100', phone: '+94701234567', password: 'TestDriver@123' },
  { email: 'driver.slt101@vehicle.com', name: 'Drivers Team 101', phone: '+94701234568', password: 'TestDriver@123' },
  { email: 'driver.slt102@vehicle.com', name: 'Drivers Team 102', phone: '+94701234569', password: 'TestDriver@123' },
  { email: 'driver.slt103@vehicle.com', name: 'Drivers Team 103', phone: '+94701234570', password: 'TestDriver@123' },
  { email: 'driver.slt104@vehicle.com', name: 'Drivers Team 104', phone: '+94701234571', password: 'TestDriver@123' },
  { email: 'driver.slt105@vehicle.com', name: 'Drivers Team 105', phone: '+94701234572', password: 'TestDriver@123' },
  { email: 'driver.slt106@vehicle.com', name: 'Drivers Team 106', phone: '+94701234573', password: 'TestDriver@123' },
  { email: 'driver.slt107@vehicle.com', name: 'Drivers Team 107', phone: '+94701234574', password: 'TestDriver@123' },
  { email: 'driver.slt108@vehicle.com', name: 'Drivers Team 108', phone: '+94701234575', password: 'TestDriver@123' },
  { email: 'driver.slt109@vehicle.com', name: 'Drivers Team 109', phone: '+94701234576', password: 'TestDriver@123' },
  { email: 'driver.slt110@vehicle.com', name: 'Drivers Team 110', phone: '+94701234577', password: 'TestDriver@123' },
  { email: 'driver.slt111@vehicle.com', name: 'Drivers Team 111', phone: '+94701234578', password: 'TestDriver@123' },
  { email: 'driver.slt112@vehicle.com', name: 'Drivers Team 112', phone: '+94701234579', password: 'TestDriver@123' },
  { email: 'driver.slt113@vehicle.com', name: 'Drivers Team 113', phone: '+94701234580', password: 'TestDriver@123' },
  { email: 'driver.slt114@vehicle.com', name: 'Drivers Team 114', phone: '+94701234581', password: 'TestDriver@123' },
  { email: 'driver.slt115@vehicle.com', name: 'Drivers Team 115', phone: '+94701234582', password: 'TestDriver@123' }
];

async function seedVehicles() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/vehicle-tracking');

    console.log('✅ Connected to MongoDB');
    
    // Create or get test drivers
    console.log('📝 Setting up test drivers...');
    const bcrypt = require('bcryptjs');
    const drivers = [];
    
    for (const driverData of TEST_DRIVERS) {
      let driver = await Driver.findOne({ email: driverData.email });
      if (!driver) {
        const hashedPassword = await bcrypt.hash(driverData.password, 10);
        driver = await Driver.create({
          email: driverData.email,
          name: driverData.name,
          phoneNumber: driverData.phone,
          password: hashedPassword,
          isEmailVerified: true
        });
      }
      drivers.push(driver);
    }
    console.log(`✅ ${drivers.length} test drivers ready\n`);
    
    // Define vehicles with driver assignments
    const TEST_VEHICLES = [
      // Route 100: Colombo - Kandy Express
      { vehicleId: 'SL100-A', vehicleName: 'High Country Express A', registrationNumber: 'REG-SL-100-A-2024', numberPlate: 'SL-NO-1001', routeId: '100', driverId: drivers[0]._id, seatCapacity: 45, vehicleType: 'AC', serviceType: 'PUBLIC', isActive: true },
      { vehicleId: 'SL100-B', vehicleName: 'High Country Express B', registrationNumber: 'REG-SL-100-B-2024', numberPlate: 'SL-NO-1002', routeId: '100', driverId: drivers[0]._id, seatCapacity: 45, vehicleType: 'AC', serviceType: 'PUBLIC', isActive: true },
      { vehicleId: 'SL100-C', vehicleName: 'Hill Country Local', registrationNumber: 'REG-SL-100-C-2024', numberPlate: 'SL-NO-1003', routeId: '100', driverId: drivers[0]._id, seatCapacity: 52, vehicleType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 101: Colombo - Galle Highway
      { vehicleId: 'SL101-A', vehicleName: 'South Coast Express', registrationNumber: 'REG-SL-101-A-2024', numberPlate: 'SL-NO-1004', routeId: '101', driverId: drivers[1]._id, seatCapacity: 45, vehicleType: 'AC', serviceType: 'PUBLIC', isActive: true },
      { vehicleId: 'SL101-B', vehicleName: 'Galle Beach Shuttle', registrationNumber: 'REG-SL-101-B-2024', numberPlate: 'SL-NO-1005', routeId: '101', driverId: drivers[1]._id, seatCapacity: 52, vehicleType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 102: Colombo - Negom Coastal
      { vehicleId: 'SL102-A', vehicleName: 'Negombo Express', registrationNumber: 'REG-SL-102-A-2024', numberPlate: 'SL-NO-1006', routeId: '102', driverId: drivers[2]._id, seatCapacity: 35, vehicleType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      { vehicleId: 'SL102-B', vehicleName: 'Coastal Highway', registrationNumber: 'REG-SL-102-B-2024', numberPlate: 'SL-NO-1007', routeId: '102', driverId: drivers[2]._id, seatCapacity: 35, vehicleType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 103: Colombo - Anuradhapura Heritage
      { vehicleId: 'SL103-A', vehicleName: 'Ancient City Express', registrationNumber: 'REG-SL-103-A-2024', numberPlate: 'SL-NO-1008', routeId: '103', driverId: drivers[3]._id, seatCapacity: 45, vehicleType: 'AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 104: Kandy - Nuwara Eliya Hill Country
      { vehicleId: 'SL104-A', vehicleName: 'Tea Country Express', registrationNumber: 'REG-SL-104-A-2024', numberPlate: 'SL-NO-1009', routeId: '104', driverId: drivers[4]._id, seatCapacity: 40, vehicleType: 'AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 105: Galle - Matara South Coast
      { vehicleId: 'SL105-A', vehicleName: 'Southern Gem', registrationNumber: 'REG-SL-105-A-2024', numberPlate: 'SL-NO-1010', routeId: '105', driverId: drivers[5]._id, seatCapacity: 35, vehicleType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 106: Colombo - Jaffna Northern Main
      { vehicleId: 'SL106-A', vehicleName: 'Northern Explorer A', registrationNumber: 'REG-SL-106-A-2024', numberPlate: 'SL-NO-1011', routeId: '106', driverId: drivers[6]._id, seatCapacity: 50, vehicleType: 'AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 107: Trincomalee - Batticaloa East Coast
      { vehicleId: 'SL107-A', vehicleName: 'East Coast Link', registrationNumber: 'REG-SL-107-A-2024', numberPlate: 'SL-NO-1012', routeId: '107', driverId: drivers[7]._id, seatCapacity: 40, vehicleType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 108: Colombo - Negombo Private Shuttle (OFFICE)
      { vehicleId: 'SL108-A', vehicleName: 'Negombo Office Shuttle', registrationNumber: 'REG-SL-108-A-2024', numberPlate: 'SL-NO-1013', routeId: '108', driverId: drivers[8]._id, seatCapacity: 20, vehicleType: 'DELUXE', serviceType: 'OFFICE', isActive: true },
      
      // Route 109: Colombo - Kandy University Shuttle (UNIVERSITY)
      { vehicleId: 'SL109-A', vehicleName: 'University Link 1', registrationNumber: 'REG-SL-109-A-2024', numberPlate: 'SL-NO-1014', routeId: '109', driverId: drivers[9]._id, seatCapacity: 50, vehicleType: 'NON-AC', serviceType: 'UNIVERSITY', isActive: true },
      { vehicleId: 'SL109-B', vehicleName: 'University Link 2', registrationNumber: 'REG-SL-109-B-2024', numberPlate: 'SL-NO-1015', routeId: '109', driverId: drivers[9]._id, seatCapacity: 50, vehicleType: 'NON-AC', serviceType: 'UNIVERSITY', isActive: true },
      
      // Route 110: Colombo - Bambalapitiya School Transport (SCHOOL)
      { vehicleId: 'SL110-A', vehicleName: 'School Vehicle A', registrationNumber: 'REG-SL-110-A-2024', numberPlate: 'SL-NO-1016', routeId: '110', driverId: drivers[10]._id, seatCapacity: 35, vehicleType: 'NON-AC', serviceType: 'SCHOOL', isActive: true },
      { vehicleId: 'SL110-B', vehicleName: 'School Vehicle B', registrationNumber: 'REG-SL-110-B-2024', numberPlate: 'SL-NO-1017', routeId: '110', driverId: drivers[10]._id, seatCapacity: 35, vehicleType: 'NON-AC', serviceType: 'SCHOOL', isActive: true },
      
      // Route 111: Kandy - Badulla Mountain Express
      { vehicleId: 'SL111-A', vehicleName: 'Mountain Express', registrationNumber: 'REG-SL-111-A-2024', numberPlate: 'SL-NO-1018', routeId: '111', driverId: drivers[11]._id, seatCapacity: 40, vehicleType: 'AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 112: Colombo - Matara Southern Express
      { vehicleId: 'SL112-A', vehicleName: 'Matara Express', registrationNumber: 'REG-SL-112-A-2024', numberPlate: 'SL-NO-1019', routeId: '112', driverId: drivers[12]._id, seatCapacity: 45, vehicleType: 'AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 113: Kurunegala - Puttalam West Route
      { vehicleId: 'SL113-A', vehicleName: 'West Route Link', registrationNumber: 'REG-SL-113-A-2024', numberPlate: 'SL-NO-1020', routeId: '113', driverId: drivers[13]._id, seatCapacity: 40, vehicleType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 114: Galle - Hikkaduwa Beach Shuttle
      { vehicleId: 'SL114-A', vehicleName: 'Beach Shuttle', registrationNumber: 'REG-SL-114-A-2024', numberPlate: 'SL-NO-1021', routeId: '114', driverId: drivers[14]._id, seatCapacity: 32, vehicleType: 'NON-AC', serviceType: 'PUBLIC', isActive: true },
      
      // Route 115: Colombo - Ratnapura Gem Route
      { vehicleId: 'SL115-A', vehicleName: 'Gem City Express', registrationNumber: 'REG-SL-115-A-2024', numberPlate: 'SL-NO-1022', routeId: '115', driverId: drivers[15]._id, seatCapacity: 40, vehicleType: 'AC', serviceType: 'PUBLIC', isActive: true }
    ];
    
    // Delete existing test vehicles to avoid duplicates
    const vehicleIds = TEST_VEHICLES.map(b => b.vehicleId);
    await Vehicle.deleteMany({ vehicleId: { $in: vehicleIds } });
    console.log('🗑️  Cleared existing test vehicles');
    
    const createdVehicles = await Vehicle.insertMany(TEST_VEHICLES);
    console.log(`\n🎉 Successfully seeded ${createdVehicles.length} test vehicles into the system\n`);

    // Group by route and display
    const vehiclesByRoute = {};
    createdVehicles.forEach((vehicle) => {
      if (!vehiclesByRoute[vehicle.routeId]) {
        vehiclesByRoute[vehicle.routeId] = [];
      }
      vehiclesByRoute[vehicle.routeId].push(vehicle);
    });

    Object.keys(vehiclesByRoute).sort().forEach((routeId) => {
      console.log(`   Route ${routeId}: ${vehiclesByRoute[routeId].length} vehicles`);
      vehiclesByRoute[routeId].forEach((vehicle) => {
        console.log(`      - ${vehicle.vehicleId}: ${vehicle.vehicleName} (${vehicle.seatCapacity} seats, ${vehicle.serviceType})`);
      });
    });

    console.log('\n✅ Database connection closed');
    await mongoose.connection.close();
  } catch (error) {
    console.error('❌ Error seeding vehicles:', error.message);
    process.exit(1);
  }
}

seedVehicles();
